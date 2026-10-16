// Connecting to a Houdry fabric control plane: which plane to use, whether to
// trust it, what credential to send, and the two OpenAI-compatible calls that
// prove the answer. Ported from the Houdry Agent's desktop and CLI layers:
//
//   electron/houdry-router.ts        findListeningFabricPort  → loopback adoption
//   src/lib/local-inference-scan.ts  scanLocalFabric, hitFrom → identity + catalog
//   src/lib/control-plane-scan.ts    scanControlPlane         → LAN browse
//   agent/ssl_verify.py              resolve_httpx_verify     → trust ladder
//   hermes_cli/houdry_tls.py         is_houdry_lan_https      → who may be pinned
//   hermes_cli/web_server.py         validate_custom_endpoint → models probe
//   hermes_cli/auth.py               has_usable_secret        → credential rules
//   openaicompat/http.go, server.go  the wire errors this classifies
//
// Two adaptations, both forced by dsh rather than chosen:
//
//   - pi-ai's route has no per-request CA field, so trust reaches the LLM
//     client as NODE_EXTRA_CA_CERTS on the process environment. That means the
//     resolved CA must be a file on disk, which is why pins are kept one file
//     per origin (as hermes_cli/houdry_tls.py does) in addition to the Agent's
//     single JSON store: a shared "last pinned CA" file would silently let one
//     plane's root validate another plane's TLS.
//   - the launcher has no picker, so "several planes answered" is an error that
//     names them, where the Agent would show a list.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { X509Certificate, createHash } from 'node:crypto'

import {
  HOUDRY_PORTS,
  configureHoudryTofu,
  defaultTofuFile,
  houdryHttpsRequest,
  isHoudryLanHttps,
  persistTofuCA,
  pinnedCAForOrigin,
  readLocalHoudryCA,
  rewriteHoudryHttps
} from './houdry-tls.mjs'
import { discoverHoudryFabric, probeHoudryControlPlane } from './houdry-fabric-discover.mjs'

/** The fabric is a router: it always answers `auto`, even with no catalog. */
export const FABRIC_MODEL_AUTO = 'auto'

/** The Agent's stand-in for an endpoint that demands a non-empty api_key but takes no credential. */
export const PLACEHOLDER_FABRIC_KEY = 'no-key-required'

export const PROBE_TIMEOUT_MS = 2_000
export const MODELS_TIMEOUT_MS = 8_000
/** A queued job waits for a worker to free the model, so a chat turn is not a loopback call. */
export const CHAT_TIMEOUT_MS = 300_000

const PLACEHOLDER_SECRETS = new Set([
  '*',
  '**',
  '***',
  'changeme',
  'your_api_key',
  'your_api_key_here',
  'your-api-key',
  'placeholder',
  'example',
  'dummy',
  'null',
  'none'
])

const INSECURE_VALUES = new Set(['1', 'true', 'yes', 'on'])

/** Only these mean "the plane is not answering right now", not "the pin is wrong". */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPROTO',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'UND_ERR_SOCKET'
])

const TLS_ERROR = /certificate|cert_|ssl|self[- ]signed|unable to verify|signature|handshake|alpn/i

/** Mirrors has_usable_secret: non-empty, at least 4 characters, not a known placeholder. */
export function hasUsableSecret(value, minLength = 4) {
  if (typeof value !== 'string') {
    return false
  }

  const cleaned = value.trim()

  return cleaned.length >= minLength && !PLACEHOLDER_SECRETS.has(cleaned.toLowerCase())
}

/**
 * Normalize any operator-supplied fabric address to the API base. A bare origin
 * gets `/v1`, because that is the only path the compatibility surface serves;
 * `rewriteHoudryHttps` upgrades the `http://` an old config or advertisement
 * still carries.
 */
export function fabricApiOf(raw) {
  let parsed

  try {
    parsed = new URL(rewriteHoudryHttps(String(raw ?? '')))
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    return null
  }

  const pathname = parsed.pathname === '' || parsed.pathname === '/' ? '/v1' : parsed.pathname

  return {
    api: `${parsed.origin}${pathname}`,
    origin: parsed.origin,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 443
  }
}

function isOpenTcp(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port, timeout: timeoutMs })
    const finish = open => {
      sock.destroy()
      resolve(open)
    }

    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/**
 * 'fabric' — a v1 control plane answers here. 'busy' — something else does, so
 * this port is taken by a squatter (Cursor, a WSL relay, llama.cpp). 'free'.
 */
export async function classifyLoopbackPort(port, { timeoutMs = PROBE_TIMEOUT_MS, isOpen = isOpenTcp, identity = probeHoudryControlPlane } = {}) {
  if (!(await isOpen('127.0.0.1', port, timeoutMs))) {
    return 'free'
  }

  return (await identity(`https://127.0.0.1:${port}`, { timeoutMs })) ? 'fabric' : 'busy'
}

/** Adopt a control plane already running on this machine instead of fighting it for a port. */
export async function findListeningFabricPort({ ports = HOUDRY_PORTS, timeoutMs = PROBE_TIMEOUT_MS, identity = probeHoudryControlPlane } = {}) {
  for (const port of ports) {
    if (await identity(`https://127.0.0.1:${port}`, { timeoutMs })) {
      return port
    }
  }

  return 0
}

function planeFromApi(api, extra = {}) {
  const parsed = fabricApiOf(api)

  if (!parsed) {
    return null
  }

  return { name: '', auth: false, openai: true, ...extra, api: parsed.api, origin: parsed.origin, url: parsed.origin }
}

/**
 * The Agent's ladder: an address the operator named, then a plane found on the
 * LAN, then a plane listening here that is not advertising.
 *
 * LAN before loopback on purpose. `houdry serve` binds 0.0.0.0 and announces
 * its real interface address, so a plane on this same laptop is found by the
 * browse and reached over WiFi; loopback is only the answer when the browse was
 * blocked (guest SSID, firewall, `--no-lan-discover`). Preferring loopback
 * would instead pin whatever a leftover local instance happens to be.
 */
export async function resolveFabricPlane({
  env = process.env,
  waitMs = 2_000,
  mdns = true,
  ports = HOUDRY_PORTS,
  discover = discoverHoudryFabric,
  identity = probeHoudryControlPlane,
  warn = () => {}
} = {}) {
  const explicit = (env.HOUDRY_FABRIC_URL ?? env.HOUDRY_BASE_URL ?? '').trim()

  if (explicit) {
    const plane = planeFromApi(explicit, { source: 'env' })

    if (!plane) {
      return { ok: false, reason: 'HOUDRY_FABRIC_URL is not a usable https control-plane address.', plane: null, planes: [] }
    }

    // Honored even when the identity document is missing: the operator may be
    // pointing at a plane behind a proxy that strips it, or one that is still
    // booting. Trust resolution still refuses to pin a public host.
    if (!(await identity(plane.origin, { timeoutMs: PROBE_TIMEOUT_MS }))) {
      warn(`${plane.origin} did not confirm it is a Houdry control plane; using it because HOUDRY_FABRIC_URL named it`)
      plane.verified = false
    } else {
      plane.verified = true
    }

    return { ok: true, plane, planes: [plane] }
  }

  const found = await discover(waitMs, { mdns })

  if (found.length > 0) {
    // WiFi isolation can block HTTP while UDP still answers, so an unreachable
    // reply is kept as a fallback rather than dropped — as in Resolve().
    // Discovery hands back a URL; every probe and pin below is keyed by origin.
    // An endpoint whose URL will not parse cannot be reached, so it is dropped.
    const checked = []

    for (const ep of found) {
      const origin = ep.origin || fabricApiOf(ep.url)?.origin || ''

      if (!origin) {
        warn(`ignoring the advertisement of ${ep.name || ep.url}: it names no usable address`)
        continue
      }

      checked.push({ ...ep, origin, verified: await identity(origin, { timeoutMs: PROBE_TIMEOUT_MS }) })
    }

    if (checked.length === 0) {
      return { ok: false, reason: 'the LAN browse answered, but none of the replies named a usable address.', plane: null, planes: [] }
    }

    const usable = checked.filter(ep => ep.verified)
    const planes = (usable.length > 0 ? usable : checked).map(ep => ({
      name: ep.name,
      url: ep.url,
      api: ep.api,
      origin: ep.origin,
      auth: ep.auth,
      openai: ep.openai,
      ...(ep.version ? { version: ep.version } : {}),
      source: ep.source ?? 'lan',
      verified: ep.verified
    }))

    if (planes.length === 1) {
      return { ok: true, plane: planes[0], planes }
    }

    const list = planes.map(ep => `  ${ep.api}${ep.name ? `  (${ep.name})` : ''}${ep.verified ? '' : '  [identity unconfirmed]'}`)

    return {
      ok: false,
      reason: `found ${planes.length} Houdry control planes; export HOUDRY_FABRIC_URL with the one to use:\n${list.join('\n')}`,
      plane: null,
      planes
    }
  }

  const port = await findListeningFabricPort({ ports, identity })

  if (port) {
    const plane = planeFromApi(`https://127.0.0.1:${port}/v1`, { source: 'loopback', verified: true })

    return { ok: true, plane, planes: [plane] }
  }

  return {
    ok: false,
    reason:
      'no Houdry control plane found. Is `houdry serve` running (without --no-lan-discover), and does this ' +
      'network let clients talk to each other? On guest WiFi, export HOUDRY_FABRIC_URL=https://<host>:<port>/v1.',
    plane: null,
    planes: []
  }
}

export function fabricTofuDir(env = process.env, homedir = undefined) {
  const file = defaultTofuFile(env, homedir)

  return path.dirname(file)
}

function originKey(origin) {
  return createHash('sha256').update(origin).digest('hex').slice(0, 16)
}

/** One PEM per origin: NODE_EXTRA_CA_CERTS trusts whatever file it is given, for every host. */
export function fabricPinFile(dir, origin) {
  return path.join(dir, 'cas', `${originKey(origin)}.crt`)
}

function isTransient(error, code) {
  if (!error) {
    return false
  }

  return TRANSIENT_CODES.has(code ?? '') || /timeout|socket hang up|other side closed/i.test(error)
}

function isCertError(error) {
  return TLS_ERROR.test(error ?? '')
}

function writePin(dir, origin, pem, storeFile) {
  const file = fabricPinFile(dir, origin)

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, pem, { encoding: 'utf8', mode: 0o600 })
  persistTofuCA(storeFile, origin, pem)

  return file
}

/** True when this PEM really is the CA the plane serves, verified rather than assumed. */
async function caValidatesOrigin(origin, pem, { request = houdryHttpsRequest, timeoutMs = 4_000 } = {}) {
  if (!pem) {
    return false
  }

  const res = await request(`${origin}/.well-known/houdry.json`, { ca: pem, timeoutMs })

  return res.ok
}

/**
 * The trust ladder of agent/ssl_verify.py: insecure override, explicit CA,
 * existing pin, the local `houdry serve` CA, then trust on first use.
 *
 * An existing pin is re-checked rather than trusted blindly, and a pin that no
 * longer validates the origin stops the launch: silently continuing would hand
 * dsh a root that is guaranteed to fail on the first message, with the failure
 * naming the model rather than the certificate.
 */
export async function resolveFabricTrust(plane, {
  env = process.env,
  tofuFile = defaultTofuFile(env),
  repin = false,
  ports = HOUDRY_PORTS,
  request = houdryHttpsRequest,
  timeoutMs = 4_000,
  homeCAFile = readLocalHoudryCA(),
  warn = () => {},
  note = () => {}
} = {}) {
  const storeFile = tofuFile

  // houdry-tls falls back to its own module store when a request names no CA,
  // so point that at the file this resolution is using before any request runs.
  configureHoudryTofu(storeFile)

  const dir = path.dirname(tofuFile)
  const origin = plane.origin
  const pinFile = fabricPinFile(dir, origin)
  // Every judgment below is reported through the caller's sinks: this runs
  // before dsh starts, so a silent trust decision is a lost diagnosis.
  const say = message => warn(message)
  const flag = message => note(message)

  const raw = (env.HOUDRY_FABRIC_INSECURE ?? '').trim().toLowerCase()

  if (INSECURE_VALUES.has(raw)) {
    say('TLS certificate verification DISABLED (HOUDRY_FABRIC_INSECURE) — intended for local development only, unsafe on any network you do not fully control.')

    return { ok: true, caFile: '', caPem: '', insecure: true, source: 'insecure' }
  }

  const explicitCA = (env.HOUDRY_FABRIC_CA ?? '').trim()

  if (explicitCA) {
    if (fs.existsSync(explicitCA)) {
      return { ok: true, caFile: explicitCA, caPem: fs.readFileSync(explicitCA, 'utf8'), insecure: false, source: 'env' }
    }

    say(`CA bundle path does not exist: ${explicitCA} — falling back to the pinned certificate`)
  }

  const pinned = pinnedCAForOrigin(origin, storeFile) || (fs.existsSync(pinFile) ? fs.readFileSync(pinFile, 'utf8') : '')

  if (pinned && !repin) {
    const res = await request(`${origin}/v1/pki/ca`, { ca: pinned, timeoutMs })

    if (res.ok && res.body.includes('BEGIN CERTIFICATE')) {
      if (derOf(res.body) === derOf(pinned)) {
        if (!fs.existsSync(pinFile) || fs.readFileSync(pinFile, 'utf8') !== pinned) {
          writePin(dir, origin, pinned, storeFile)
        }

        return { ok: true, caFile: pinFile, caPem: pinned, insecure: false, source: 'pin' }
      }

      return { ok: false, code: 'rotated', ...rotationMessage(origin, pinFile) }
    }

    if (!res.ok && res.status === 0 && isCertError(res.error)) {
      return { ok: false, code: 'rotated', ...rotationMessage(origin, pinFile) }
    }

    if (res.status === 0) {
      say(`could not re-check the pinned CA for ${origin} (${res.error || 'unreachable'}); continuing with it`)

      return { ok: true, caFile: pinFile, caPem: pinned, insecure: false, source: 'pin' }
    }

    // The pin still holds the plane's own TLS; it only means this build does
    // not publish /v1/pki/ca, so there is nothing to compare it against.
    say(`${origin} answered /v1/pki/ca with HTTP ${res.status}; keeping the pinned CA`)

    return { ok: true, caFile: pinFile, caPem: pinned, insecure: false, source: 'pin' }
  }

  if (repin && pinned) {
    flag(`re-pinning ${origin} as requested; the previous CA at ${pinFile} is being replaced`)
  }

  // A plane on this machine already has its root in ~/.houdry/server/pki, and
  // that file is the one copy of the CA that did not come over the network.
  if (homeCAFile && (await caValidatesOrigin(origin, homeCAFile, { request, timeoutMs }))) {
    const file = writePin(dir, origin, homeCAFile, storeFile)

    flag(`pinned the control-plane CA from ${origin}, verified against the local houdry home root`)

    return { ok: true, caFile: file, caPem: homeCAFile, insecure: false, source: 'local' }
  }

  // Fetch-and-trust without verification is the one request this integration
  // makes unprotected, so the Agent's bound applies: a private host, on a port
  // houdry serve uses or confirmed by its own identity document.
  const confirmed = plane.verified === true || plane.source === 'loopback'

  if (!isHoudryLanHttps(origin, ports, { confirmed })) {
    return {
      ok: false,
      code: 'public',
      error:
        `refusing to trust ${origin} without verification: it is not a private (RFC1918 or loopback) address on a ` +
        `Houdry port. Export HOUDRY_FABRIC_CA with a CA file you obtained another way.`
    }
  }

  const res = await request(`${origin}/v1/pki/ca`, { insecure: true, timeoutMs })

  if (res.status === 0) {
    return { ok: false, code: 'unreachable', error: `could not reach ${origin} to pin its CA: ${res.error || 'no answer'}` }
  }

  if (!res.ok || !res.body.includes('BEGIN CERTIFICATE')) {
    return {
      ok: false,
      code: 'no_ca',
      error: `GET ${origin}/v1/pki/ca returned HTTP ${res.status} with no certificate: is this a Houdry control plane?`
    }
  }

  let cert

  try {
    cert = new X509Certificate(res.body)
  } catch {
    return { ok: false, code: 'no_ca', error: `the PEM served by ${origin}/v1/pki/ca is not a certificate` }
  }

  if (!cert.ca) {
    return { ok: false, code: 'no_ca', error: `the PEM served at ${origin}/v1/pki/ca is not a certificate authority; refusing to pin ${origin}` }
  }

  const file = writePin(dir, origin, res.body, storeFile)

  flag(`pinned the CA of ${origin} at ${file} (trust on first use)`)

  return { ok: true, caFile: file, caPem: res.body, insecure: false, source: 'tofu' }
}

function rotationMessage(origin, pinFile) {
  return {
    error:
      `the certificate authority pinned at ${pinFile} no longer validates ${origin}. ` +
      'If the plane was rebuilt or its CA rotated, re-run with HOUDRY_FABRIC_REPIN=1 (or --repin); if you did not ' +
      'expect that, something else may be answering for this address.'
  }
}

/** Compare by DER, so PEM line endings or a re-encoded header cannot fake a change. */
function derOf(pem) {
  try {
    return Buffer.from(new X509Certificate(pem).raw).toString('base64')
  } catch {
    return String(pem)
  }
}

/** The Agent's credential rule: a usable secret, or the placeholder a keyless endpoint still requires. */
export function resolveFabricCredential(plane, { env = process.env } = {}) {
  const explicit = (env.HOUDRY_FABRIC_KEY ?? '').trim()

  if (hasUsableSecret(explicit)) {
    return { ok: true, key: explicit, placeholder: false }
  }

  if (plane.auth === true) {
    return {
      ok: false,
      error: `${plane.api} requires a token: export HOUDRY_FABRIC_KEY with the value passed to 'houdry serve --token'.`
    }
  }

  return { ok: true, key: PLACEHOLDER_FABRIC_KEY, placeholder: true }
}

/**
 * Only `Authorization: Bearer` is sent, which server.authorized() accepts after
 * its X-Houdry-Token check; an empty value is omitted rather than sent as a
 * bare "Bearer ", which some gateways answer 401.
 */
export function fabricAuthHeaders(key) {
  const value = String(key ?? '').trim()

  return value ? { Authorization: `Bearer ${value}` } : {}
}

/** Tolerant of {"data":[{"id":..}]} and a bare {"data":["id"]}, like _parse_model_ids. */
export function parseModelIds(body) {
  let payload

  try {
    payload = JSON.parse(body)
  } catch {
    return []
  }

  const data = Array.isArray(payload) ? payload : payload?.data

  if (!Array.isArray(data)) {
    return []
  }

  return data
    .map(item => String((item && typeof item === 'object' ? item.id : item) ?? '').trim())
    .filter(Boolean)
}

/**
 * Both error shapes the fabric writes: openaicompat.WriteError's nested
 * {"error":{"message","type","code"}}, and server.authorized()'s flat
 * {"error":"unauthorized"}.
 */
export function describeFabricError(status, body) {
  let parsed = null

  try {
    parsed = JSON.parse(body)
  } catch {
    // A proxy or a plain-text handler answers this way; the status still counts.
  }

  const err = parsed?.error
  let code = ''
  let message = ''

  if (typeof err === 'string') {
    code = err
    message = err
  } else if (err && typeof err === 'object') {
    code = String(err.code ?? '')
    message = String(err.message ?? '')
  }

  if (!message) {
    message = String(body ?? '').slice(0, 300).trim() || `HTTP ${status}`
  }

  return { status, code, message, hint: FABRIC_ERROR_HINTS[code] ?? FABRIC_STATUS_HINTS[status] ?? '', retryable: status === 0 || status >= 500 || status === 429 }
}

const FABRIC_ERROR_HINTS = {
  unauthorized: "the plane has a token and refused this one; export HOUDRY_FABRIC_KEY with the value passed to 'houdry serve --token'",
  no_suitable_node: 'no READY GPU worker can take this model right now — run `houdry gpu register` on a worker, or ask for a model that fits its free VRAM',
  model_unavailable: 'no READY node holds this model with a compatible runtime; GET /v1/models lists what the plane accepts',
  model_no_tools: 'the harness sends a tool catalog with every turn; install a tool-capable model (for example qwen2.5-coder) or select model=auto',
  invalid_model: 'model is required; the fabric accepts any id from GET /v1/models, including auto',
  unsupported_modality: 'the pipeline has no handler for this content type; send text, or attach it as a file reference',
  runtime_error: 'a worker took the job and its runtime failed; check `houdry jobs` for the node and the model',
  empty_response: 'the worker answered with nothing; the model is loaded but produced no tokens'
}

const FABRIC_STATUS_HINTS = {
  401: 'the plane refused the credential',
  403: 'the plane refused this caller',
  404: 'this plane does not serve that path — check that HOUDRY_FABRIC_URL ends in /v1',
  502: 'the plane reached a worker and the worker failed',
  503: 'the plane has nowhere to run the job yet'
}

/** The Agent's local-inference probe contract: {ok, reachable, message, models}, and never a throw. */
export async function listFabricModels({
  api,
  key = '',
  caPem = '',
  insecure = false,
  timeoutMs = MODELS_TIMEOUT_MS,
  request = houdryHttpsRequest
} = {}) {
  const url = `${String(api).replace(/\/+$/, '')}/models`
  const res = await request(url, { headers: { Accept: 'application/json', ...fabricAuthHeaders(key) }, ca: caPem, insecure, timeoutMs })

  if (res.status === 0) {
    return { ok: false, code: 'unreachable', reachable: false, message: `Could not reach ${url}.`, models: [] }
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: 'unauthorized', reachable: true, message: 'The endpoint rejected the API key.', models: [] }
  }

  if (!res.ok) {
    const described = describeFabricError(res.status, res.body)

    return { ok: false, code: described.code || 'http', reachable: true, message: `Endpoint returned HTTP ${res.status}: ${described.message}`, models: [] }
  }

  return { ok: true, code: '', reachable: true, message: '', models: parseModelIds(res.body) }
}

/** Content is a string on the wire, but the compat layer can carry parts. */
function messageText(message) {
  const content = message?.content

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('')
  }

  return ''
}

/**
 * One non-streaming chat completion. Returns the reply, or the fabric's own
 * error code with the hint an operator needs — a queued job failing because no
 * worker fits the model is a different fix from a refused token.
 */
export async function fabricChatCompletion({
  api,
  model = FABRIC_MODEL_AUTO,
  messages,
  key = '',
  caPem = '',
  insecure = false,
  temperature,
  maxTokens,
  tools,
  timeoutMs = CHAT_TIMEOUT_MS,
  request = houdryHttpsRequest
} = {}) {
  const url = `${String(api).replace(/\/+$/, '')}/chat/completions`
  const body = { model, messages, stream: false }

  if (temperature !== undefined) {
    body.temperature = temperature
  }

  // The fabric's request struct names this field max_tokens, not max_completion_tokens.
  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens
  }

  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
  }

  const res = await request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { ...fabricAuthHeaders(key) },
    ca: caPem,
    insecure,
    timeoutMs
  })

  if (res.status === 0) {
    return { ok: false, status: 0, code: 'unreachable', message: `no answer from ${url}: ${res.error || 'connection failed'}`, retryable: true }
  }

  if (!res.ok) {
    const described = describeFabricError(res.status, res.body)

    return { ok: false, ...described }
  }

  let parsed

  try {
    parsed = JSON.parse(res.body)
  } catch {
    return { ok: false, status: res.status, code: 'bad_json', message: 'the plane returned a response that is not JSON', retryable: false }
  }

  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined

  if (!choice) {
    return { ok: false, status: res.status, code: 'no_choices', message: 'the plane returned no completion choices', retryable: false }
  }

  return {
    ok: true,
    status: res.status,
    id: parsed.id ?? '',
    model: parsed.model ?? model,
    content: messageText(choice.message),
    toolCalls: choice.message?.tool_calls ?? null,
    finishReason: choice.finish_reason ?? '',
    usage: parsed.usage ?? null
  }
}

/**
 * Everything the launcher needs, in one call: plane, trust, credential, and the
 * catalog the plane is currently willing to serve.
 */
export async function connectFabric(opts = {}) {
  const notes = []
  const warn = message => notes.push(message)
  const note = message => notes.push(message)

  const resolved = await resolveFabricPlane({ ...opts, warn, note })

  if (!resolved.ok) {
    return { ok: false, code: 'plane', error: resolved.reason, planes: resolved.planes, notes }
  }

  const plane = resolved.plane
  const trust = await resolveFabricTrust(plane, { ...opts, warn, note })

  if (!trust.ok) {
    return { ok: false, code: trust.code ?? 'tls', error: trust.error, plane, notes }
  }

  const credential = resolveFabricCredential(plane, opts)

  if (!credential.ok) {
    return { ok: false, code: 'auth', error: credential.error, plane, notes }
  }

  const probe = await listFabricModels({
    api: plane.api,
    key: credential.key,
    caPem: trust.caPem,
    insecure: trust.insecure,
    timeoutMs: opts.modelsTimeoutMs ?? MODELS_TIMEOUT_MS,
    request: opts.request ?? houdryHttpsRequest
  })

  // hitFrom(): reachable is not the same as usable. A router with nothing to
  // list still answers `auto`, but a plane that answered nothing at all has no
  // model to route to, and launching into it would turn one clear error into an
  // opaque pi-ai failure on the first message.
  if (!probe.ok && probe.code === 'unreachable') {
    return { ok: false, code: 'unreachable', error: `${probe.message} Is 'houdry serve' running, and may this machine reach ${plane.origin}?`, plane, notes }
  }

  if (!probe.ok) {
    const hint = probe.code === 'unauthorized' ? " Export HOUDRY_FABRIC_KEY with the value passed to 'houdry serve --token'." : ''

    return { ok: false, code: probe.code || 'models', error: `${plane.api}: ${probe.message}.${hint}`, plane, notes }
  }

  const models = probe.models.length > 0 ? probe.models : [FABRIC_MODEL_AUTO]

  if (probe.models.length === 0) {
    note(`${plane.api} listed no models; the router will still answer '${FABRIC_MODEL_AUTO}'`)
  }

  return {
    ok: true,
    plane,
    api: plane.api,
    caFile: trust.caFile,
    insecure: trust.insecure,
    // Only the placeholder is returned for the launcher to export. A real token
    // stays where the operator put it: printing it here would copy a credential
    // into a shell variable, a command trace, or a log.
    exportKey: credential.placeholder ? credential.key : '',
    placeholder: credential.placeholder,
    models,
    notes
  }
}
