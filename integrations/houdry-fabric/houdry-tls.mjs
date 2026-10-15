// TLS trust for a Houdry fabric control plane, ported from the Houdry Agent's
// apps/desktop/electron/houdry-tls.ts and hermes_cli/houdry_tls.py.
//
// `houdry serve` answers HTTPS from a CA private to the cluster, so Node,
// Python and curl all reject it until that CA is trusted. The agent's answer is
// trust on first use with three properties this port keeps:
//
//   - pins live in one JSON store keyed by origin, mode 0600
//   - a pin is fetched without verification exactly once, and every later call
//     is verified against it, never against the system roots
//   - the fetch-and-trust path is bounded to loopback and RFC1918 hosts on the
//     ports `houdry serve` uses, so a public URL never lands in the store
//
// Errors are values here, not exceptions: the agent's `houdryHttpsGet` resolves
// {ok: false, status: 0} on any failure, because discovery and pinning must not
// be able to abort a chat request that has not started yet.

import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Ports `houdry serve` actually uses: 18080 first, then 8090/8080 when taken. */
export const HOUDRY_PORTS = [18_080, 8090, 8080]

/** Pin store path used when a caller does not name one; see configureHoudryTofu. */
let tofuStoreFile = ''

export function houdryHome(env = process.env, homedir = os.homedir()) {
  const override = (env.HOUDRY_HOME ?? '').trim()

  return override || path.join(homedir, '.houdry')
}

export function localHoudryCAPath(home = houdryHome()) {
  return path.join(home, 'server', 'pki', 'root_ca.crt')
}

export function fabricHttpsOrigin(port) {
  return `https://127.0.0.1:${port}`
}

export function fabricHttpsApi(port) {
  return `${fabricHttpsOrigin(port)}/v1`
}

/** Upgrade a control-plane URL to https:// — old advertisements and configs say http. */
export function rewriteHoudryHttps(raw) {
  const trimmed = String(raw).trim().replace(/\/+$/, '')

  return trimmed.startsWith('http://') ? `https://${trimmed.slice('http://'.length)}` : trimmed
}

export function readLocalHoudryCA(home = houdryHome()) {
  try {
    return fs.readFileSync(localHoudryCAPath(home), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Make a PEM the process-wide trust root. NODE_EXTRA_CA_CERTS is read when Node
 * starts, so this reaches child processes — the Python backend in the agent,
 * `dsh` here — rather than reconfiguring a live TLS stack.
 */
export function applyHoudryCATrust(pem, destFile, env = process.env) {
  if (!pem.trim()) {
    return
  }

  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  fs.writeFileSync(destFile, pem, { encoding: 'utf8', mode: 0o644 })
  env.SSL_CERT_FILE = destFile
  env.REQUESTS_CA_BUNDLE = destFile
  env.NODE_EXTRA_CA_CERTS = destFile
}

/** After a local `houdry serve` is up, pin its root CA for Node and Python https. */
export function trustLocalHoudryCA(home = houdryHome(), env = process.env) {
  const pem = readLocalHoudryCA(home)

  if (!pem) {
    return ''
  }

  const dest = path.join(home, 'node', 'agent-ca.crt')

  applyHoudryCATrust(pem, dest, env)

  return dest
}

function isPrivateOrLoopback(host) {
  const h = host.toLowerCase()

  if (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]') {
    return true
  }

  const parts = h.split('.')

  if (parts.length !== 4) {
    return false
  }

  const nums = parts.map(Number)

  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false
  }

  const [a, b] = nums

  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/**
 * True when pinning this URL is allowed: a private host on a port `houdry
 * serve` uses. This is the agent's guard against fetching and trusting a CA
 * for a public internet host, so keep both halves — a private-range check is
 * not enough when the port is unrestricted, and a port check alone accepts a
 * public IP.
 *
 * `confirmed` is the adaptation this port needs: `houdry serve` falls back from
 * 18080 to whatever free port it picks, so the fixed port list is only a proxy
 * for "this is a control plane". A caller that has already read
 * /.well-known/houdry.json from the origin knows it directly, and then the host
 * check alone is the meaningful limit.
 */
export function isHoudryLanHttps(url, ports = HOUDRY_PORTS, { confirmed = false } = {}) {
  let parsed

  try {
    parsed = new URL(String(url).trim())
  } catch {
    return false
  }

  if (parsed.protocol !== 'https:') {
    return false
  }

  const host = parsed.hostname

  if (!host || !isPrivateOrLoopback(host)) {
    return false
  }

  const port = parsed.port ? Number(parsed.port) : 443

  return confirmed || ports.includes(port)
}

export function tofuStorePath(userData) {
  return path.join(userData, 'houdry-tofu-ca.json')
}

export function loadTofuStore(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))

    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Store one origin's CA and return its fingerprint, so a change is detectable. */
export function persistTofuCA(file, origin, pem) {
  const fingerprint = createHash('sha256').update(pem).digest('hex')
  const store = loadTofuStore(file)

  store[origin] = { fingerprint, pem }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

  return fingerprint
}

export function pinnedCAForOrigin(origin, file = tofuStoreFile) {
  if (!file) {
    return ''
  }

  return loadTofuStore(file)[origin]?.pem ?? ''
}

/** The agent's module-level store path (configureHoudryTofu in Electron's main). */
export function configureHoudryTofu(file) {
  tofuStoreFile = file
}

/** Default pin store: the agent keeps it under Electron userData, dsh under its own home. */
export function defaultTofuFile(env = process.env, homedir = os.homedir()) {
  const dir = (env.HOUDRY_FABRIC_TOFU_DIR ?? '').trim() || path.join(homedir, '.houdry-dsh')

  return tofuStorePath(dir)
}

export function httpsAgentForCA(ca, insecure = false) {
  return new https.Agent({
    ca: ca || undefined,
    rejectUnauthorized: !insecure && Boolean(ca)
  })
}

/**
 * GET {origin}/v1/pki/ca and keep it. Best effort on purpose: the agent's
 * comment is the rule — a first-contact pin that fails must not abort the
 * probe that is about to work, and the next call retries.
 */
export async function pinRemoteCA(origin, { timeoutMs = 2_000, tofuFile = tofuStoreFile, fetchImpl = houdryHttpsGet } = {}) {
  if (!tofuFile || !origin) {
    return ''
  }

  const res = await fetchImpl(`${origin}/v1/pki/ca`, { insecure: true, timeoutMs, skipPin: true, tofuFile })

  if (!res.ok || !res.body.includes('BEGIN CERTIFICATE')) {
    return ''
  }

  persistTofuCA(tofuFile, origin, res.body)

  return res.body
}

/**
 * One HTTPS GET with the fabric's trust rules applied: a pin wins over an
 * insecure probe, the absence of a pin means "look but do not trust", and a
 * successful unverified look at a private plane pins it for later.
 */
export function houdryHttpsGet(
  url,
  { ca = '', insecure = false, timeoutMs = 2_000, skipPin = false, tofuFile = tofuStoreFile } = {}
) {
  let origin = ''

  try {
    origin = new URL(url).origin
  } catch {
    origin = ''
  }

  const pinned = ca || pinnedCAForOrigin(origin, tofuFile)
  const relaxed = Boolean(insecure) || !pinned

  return new Promise(resolve => {
    const req = https.get(
      url,
      { agent: httpsAgentForCA(pinned, relaxed), timeout: timeoutMs },
      res => {
        const chunks = []

        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          const ok = status >= 200 && status < 300
          const body = Buffer.concat(chunks).toString('utf8')

          if (ok && relaxed && origin && !skipPin && isHoudryLanHttps(origin)) {
            void pinRemoteCA(origin, { timeoutMs, tofuFile })
          }

          resolve({ ok, status, body })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, status: 0, body: '' })
    })
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }))
  })
}

/**
 * Same trust rules as `houdryHttpsGet`, for a request that carries a body, plus
 * the transport error as a value. `houdryHttpsGet` cannot show that: the agent
 * swallows it because a failed probe is "not there". A certificate check that
 * decides whether a pin has rotated has to see why it failed — "the plane is
 * down" and "the plane presented a different CA" call for opposite answers.
 */
export function houdryHttpsRequest(
  url,
  { method = 'GET', body = null, headers = {}, ca = '', insecure = false, timeoutMs = 2_000, tofuFile = tofuStoreFile } = {}
) {
  let parsed

  try {
    parsed = new URL(url)
  } catch (cause) {
    return Promise.resolve({ ok: false, status: 0, body: '', error: String(cause?.message ?? cause) })
  }

  const pinned = ca || pinnedCAForOrigin(parsed.origin, tofuFile)
  const relaxed = Boolean(insecure) || !pinned

  return new Promise(resolve => {
    const req = https.request(
      url,
      {
        method,
        headers,
        agent: httpsAgentForCA(pinned, relaxed),
        timeout: timeoutMs,
        // The fabric's TLS listener serves HTTP/1.1 only; negotiating h2 would
        // make every request wait out an ALPN failure.
        ALPNProtocols: ['http/1.1']
      },
      res => {
        const chunks = []

        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => {
          const status = res.statusCode ?? 0

          resolve({ ok: status >= 200 && status < 300, status, body: Buffer.concat(chunks).toString('utf8'), error: '' })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, status: 0, body: '', error: 'timeout' })
    })
    req.on('error', cause =>
      resolve({ ok: false, status: 0, body: '', error: String(cause?.message ?? cause), code: cause?.code ?? '' })
    )

    if (body !== null) {
      req.setHeader('content-type', 'application/json')
      req.end(body)
      return
    }

    req.end()
  })
}
