// The resolution, trust, credential and request rules ported from the Agent's
// houdry-router.ts, control-plane-scan.ts, local-inference-scan.ts, auth.py and
// ssl_verify.py. The plane, the CA and the wire are all faked here: what is
// under test is the ladder and the judgment, not TLS or the fabric binary.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  FABRIC_MODEL_AUTO,
  PLACEHOLDER_FABRIC_KEY,
  classifyLoopbackPort,
  connectFabric,
  describeFabricError,
  fabricApiOf,
  fabricAuthHeaders,
  fabricChatCompletion,
  fabricPinFile,
  findListeningFabricPort,
  hasUsableSecret,
  listFabricModels,
  parseModelIds,
  resolveFabricCredential,
  resolveFabricPlane,
  resolveFabricTrust
} from '../houdry-connection.mjs'
import { pinnedCAForOrigin, persistTofuCA } from '../houdry-tls.mjs'
import { ROOT_A, ROOT_B } from './fixtures.mjs'

const LAN = 'https://192.168.1.20:18080'

function tempDir(prefix = 'houdry-conn-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function plane(over = {}) {
  return { api: `${LAN}/v1`, origin: LAN, host: '192.168.1.20', port: 18080, name: 'houdry-lab', auth: false, openai: true, source: 'lan', verified: true, ...over }
}

function res(over = {}) {
  return { ok: true, status: 200, body: '', error: '', code: '', ...over }
}

/** A transport that answers by URL suffix and records what it was asked for. */
function fakeRequest(handlers = {}) {
  const seen = []
  const request = async (url, opts = {}) => {
    seen.push({ url, ...opts })
    const hit = Object.entries(handlers).find(([suffix]) => url.endsWith(suffix))

    if (!hit) {
      return res({ ok: false, status: 0, error: `test transport has no route for ${url}` })
    }

    const value = typeof hit[1] === 'function' ? hit[1](url, opts) : hit[1]

    return res(typeof value === 'string' ? { body: value } : value)
  }

  request.seen = seen
  return request
}

/** The identity document every LAN path insists on before adopting a plane. */
function identityFake(okFor = [LAN]) {
  return async origin => okFor.includes(origin)
}

/** What parseHoudryAdvertise really returns: a URL, and no origin field. */
function lanEndpoint(over = {}) {
  return { name: 'houdry-lab', url: LAN, api: `${LAN}/v1`, auth: false, openai: true, source: 'udp', ...over }
}

describe('hasUsableSecret', () => {
  it('follows the Agent rule: long enough and not a known placeholder', () => {
    assert.equal(hasUsableSecret('0011223344556677'), true)
    assert.equal(hasUsableSecret('  spaced-token  '), true)
    assert.equal(hasUsableSecret('abc'), false)
    assert.equal(hasUsableSecret(''), false)
    assert.equal(hasUsableSecret('changeme'), false)
    assert.equal(hasUsableSecret('YOUR_API_KEY'), false)
    assert.equal(hasUsableSecret('***'), false)
    assert.equal(hasUsableSecret(undefined), false)
    assert.equal(hasUsableSecret(42), false)
  })
})

describe('fabricApiOf', () => {
  it('adds /v1 and upgrades http, keeping host and port for the trust rules', () => {
    assert.deepEqual(fabricApiOf('https://192.168.1.20:18080'), {
      api: 'https://192.168.1.20:18080/v1',
      origin: 'https://192.168.1.20:18080',
      host: '192.168.1.20',
      port: 18080
    })
    assert.equal(fabricApiOf('http://10.0.0.5:8090/').api, 'https://10.0.0.5:8090/v1')
    assert.equal(fabricApiOf('https://fabric.test/v1/').api, 'https://fabric.test/v1')
    assert.equal(fabricApiOf('https://fabric.test:443').port, 443)
  })

  it('refuses anything that is not an https control-plane address', () => {
    assert.equal(fabricApiOf(''), null)
    assert.equal(fabricApiOf('not a url'), null)
    assert.equal(fabricApiOf('ftp://192.168.1.20:18080'), null)
  })
})

describe('classifyLoopbackPort and findListeningFabricPort', () => {
  it('separates a free port from a squatter and a control plane', async () => {
    const open = port => port === 8080 || port === 8090

    assert.equal(await classifyLoopbackPort(8080, { isOpen: () => false, identity: () => true }), 'free')
    assert.equal(await classifyLoopbackPort(8080, { isOpen: () => open, identity: async o => o === LAN }), 'busy')
    assert.equal(await classifyLoopbackPort(8080, { isOpen: () => open, identity: async o => o === 'https://127.0.0.1:8080' }), 'fabric')
  })

  it('adopts the first houdry port that confirms its identity, in order', async () => {
    const asked = []
    const identity = async origin => {
      asked.push(origin)
      return origin === 'https://127.0.0.1:8090'
    }

    assert.equal(await findListeningFabricPort({ ports: [18080, 8090, 8080], identity }), 8090)
    assert.deepEqual(asked, ['https://127.0.0.1:18080', 'https://127.0.0.1:8090'])
    assert.equal(await findListeningFabricPort({ ports: [18080, 8090], identity: () => false }), 0)
  })
})

describe('resolveFabricPlane', () => {
  it('honors an address the operator named, even over a LAN reply', async () => {
    const discovered = []
    const resolved = await resolveFabricPlane({
      env: { HOUDRY_FABRIC_URL: 'http://10.0.0.9:8090' },
      discover: async () => {
        discovered.push('called')
        return [lanEndpoint()]
      },
      identity: identityFake(['https://10.0.0.9:8090'])
    })

    assert.equal(resolved.ok, true)
    assert.equal(resolved.plane.api, 'https://10.0.0.9:8090/v1')
    assert.equal(resolved.plane.source, 'env')
    assert.equal(resolved.plane.verified, true)
    assert.deepEqual(discovered, [])
  })

  it('uses an unverified explicit address but says so', async () => {
    const notes = []
    const resolved = await resolveFabricPlane({
      env: { HOUDRY_BASE_URL: 'https://proxy.internal/fabric' },
      identity: () => false,
      warn: message => notes.push(message)
    })

    assert.equal(resolved.ok, true)
    assert.equal(resolved.plane.verified, false)
    assert.match(notes.join(' '), /did not confirm it is a Houdry control plane/)
  })

  it('refuses a HOUDRY_FABRIC_URL that is not usable', async () => {
    const resolved = await resolveFabricPlane({ env: { HOUDRY_FABRIC_URL: 'nonsense' }, identity: () => false })

    assert.equal(resolved.ok, false)
    assert.match(resolved.reason, /HOUDRY_FABRIC_URL/)
  })

  it('takes a single LAN plane and keeps an unreachable one as the fallback', async () => {
    const reachable = await resolveFabricPlane({ env: {}, discover: async () => [lanEndpoint()], identity: identityFake() })

    assert.equal(reachable.ok, true)
    assert.equal(reachable.plane.name, 'houdry-lab')
    assert.equal(reachable.plane.verified, true)

    // WiFi isolation: UDP answered, HTTP did not. Resolve() still returns it.
    const quiet = await resolveFabricPlane({ env: {}, discover: async () => [lanEndpoint()], identity: () => false })

    assert.equal(quiet.ok, true)
    assert.equal(quiet.plane.verified, false)
  })

  it('refuses to guess between several planes and names each', async () => {
    const second = 'https://192.168.1.31:8090'
    const resolved = await resolveFabricPlane({
      env: {},
      discover: async () => [lanEndpoint(), lanEndpoint({ name: 'houdry-rig', url: second, api: `${second}/v1` })],
      identity: identityFake([LAN, second])
    })

    assert.equal(resolved.ok, false)
    assert.equal(resolved.planes.length, 2)
    assert.match(resolved.reason, /found 2 Houdry control planes/)
    assert.match(resolved.reason, /192\.168\.1\.20:18080\/v1\s+\(houdry-lab\)/)
    assert.match(resolved.reason, /192\.168\.1\.31:8090\/v1\s+\(houdry-rig\)/)

    // Two planes that both only answered UDP are still two planes, and the
    // list says so — adopting either one would be a guess.
    const bothQuiet = await resolveFabricPlane({
      env: {},
      discover: async () => [lanEndpoint(), lanEndpoint({ name: 'houdry-rig', url: second, api: `${second}/v1` })],
      identity: () => false
    })

    assert.equal(bothQuiet.ok, false)
    assert.match(bothQuiet.reason, /\[identity unconfirmed\]/)
  })

  it('picks the plane that confirms its identity over one that only answered UDP', async () => {
    const squatter = 'https://192.168.1.31:8090'
    const resolved = await resolveFabricPlane({
      env: {},
      discover: async () => [lanEndpoint({ name: 'not-a-plane', url: squatter, api: `${squatter}/v1`, origin: squatter }), lanEndpoint()],
      identity: identityFake([LAN])
    })

    assert.equal(resolved.ok, true)
    assert.equal(resolved.plane.origin, LAN)
    assert.equal(resolved.planes.length, 1)
  })

  it('prefers the LAN over a plane listening here, and falls back to loopback', async () => {
    const lanFirst = await resolveFabricPlane({
      env: {},
      discover: async () => [lanEndpoint()],
      identity: origin => Promise.resolve(origin === LAN || origin === 'https://127.0.0.1:8080')
    })

    assert.equal(lanFirst.plane.origin, LAN)

    const loopback = await resolveFabricPlane({
      env: {},
      discover: async () => [],
      identity: origin => Promise.resolve(origin === 'https://127.0.0.1:8080')
    })

    assert.equal(loopback.ok, true)
    assert.equal(loopback.plane.source, 'loopback')
    assert.equal(loopback.plane.api, 'https://127.0.0.1:8080/v1')
  })

  it('explains the answer when nothing is out there', async () => {
    const resolved = await resolveFabricPlane({ env: {}, discover: async () => [], identity: () => false })

    assert.equal(resolved.ok, false)
    assert.match(resolved.reason, /houdry serve/)
    assert.match(resolved.reason, /guest WiFi/)
  })

  it('probes the origin of a reply that carries only a URL', async () => {
    const asked = []
    const identity = async origin => {
      asked.push(origin)
      return true
    }
    const resolved = await resolveFabricPlane({
      env: {},
      discover: async () => [lanEndpoint({ url: 'http://192.168.1.40:8090', api: 'https://192.168.1.40:8090/v1' }), lanEndpoint({ name: 'junk', url: 'nonsense', api: 'nonsense/v1' })],
      identity,
      warn: () => {}
    })

    assert.equal(resolved.ok, true)
    // An http:// advertisement is upgraded before it is probed, and what gets
    // probed is the origin — the identity document is served there, not under
    // /v1. The reply with no address at all is dropped instead of adopted.
    assert.deepEqual(asked, ['https://192.168.1.40:8090'])
    assert.equal(resolved.plane.origin, 'https://192.168.1.40:8090')
    assert.equal(resolved.planes.length, 1)

    const allJunk = await resolveFabricPlane({ env: {}, discover: async () => [lanEndpoint({ url: 'nonsense', api: 'nonsense' })], identity, warn: () => {} })

    assert.equal(allJunk.ok, false)
    assert.match(allJunk.reason, /named a usable address/)
  })
})

describe('resolveFabricTrust', () => {
  function trustOpts(over = {}) {
    const dir = tempDir()

    return {
      opts: { tofuFile: path.join(dir, 'houdry-tofu-ca.json'), env: {}, homeCAFile: '', ...over },
      dir
    }
  }

  it('lets the insecure override skip every other rule', async () => {
    const { opts } = trustOpts({ env: { HOUDRY_FABRIC_INSECURE: 'yes' } })
    const notes = []
    const trust = await resolveFabricTrust(plane(), { ...opts, warn: m => notes.push(m), request: () => { throw new Error('must not request') } })

    assert.deepEqual(trust, { ok: true, caFile: '', caPem: '', insecure: true, source: 'insecure' })
    assert.match(notes.join(' '), /DISABLED/)
  })

  it('takes an explicit CA file over a pin, and ignores one that is missing', async () => {
    const { opts, dir } = trustOpts()
    const caFile = path.join(dir, 'ops-provided.crt')

    fs.writeFileSync(caFile, ROOT_A)
    persistTofuCA(opts.tofuFile, LAN, ROOT_B)

    const explicit = await resolveFabricTrust(plane(), { ...opts, env: { HOUDRY_FABRIC_CA: caFile }, request: fakeRequest() })

    assert.equal(explicit.source, 'env')
    assert.equal(explicit.caFile, caFile)

    const notes = []
    const missing = await resolveFabricTrust(plane(), {
      ...opts,
      env: { HOUDRY_FABRIC_CA: path.join(dir, 'gone.crt') },
      warn: m => notes.push(m),
      request: fakeRequest({ '/v1/pki/ca': ROOT_B })
    })

    assert.equal(missing.source, 'pin')
    assert.match(notes.join(' '), /CA bundle path does not exist/)
  })

  it('pins on first contact and writes one PEM per origin', async () => {
    const { opts, dir } = trustOpts()
    const notes = []
    const trust = await resolveFabricTrust(plane(), { ...opts, request: fakeRequest({ '/v1/pki/ca': ROOT_A }), note: m => notes.push(m) })

    assert.equal(trust.ok, true)
    assert.equal(trust.source, 'tofu')
    assert.equal(trust.caFile, fabricPinFile(dir, LAN))
    assert.equal(fs.readFileSync(trust.caFile, 'utf8'), ROOT_A)
    assert.equal(pinnedCAForOrigin(LAN, opts.tofuFile), ROOT_A)
    assert.match(notes.join(' '), /trust on first use/)
  })

  it('refuses to pin a public host, or a private one off the houdry ports', async () => {
    const { opts } = trustOpts()
    const publicPlane = plane({ origin: 'https://fabric.example.com:18080', api: 'https://fabric.example.com:18080/v1' })
    const refused = await resolveFabricTrust(publicPlane, { ...opts, request: fakeRequest({ '/v1/pki/ca': ROOT_A }) })

    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'public')
    assert.match(refused.error, /HOUDRY_FABRIC_CA/)

    const oddPort = plane({ origin: 'https://192.168.1.20:9000', api: 'https://192.168.1.20:9000/v1', verified: false })

    assert.equal((await resolveFabricTrust(oddPort, { ...opts, request: fakeRequest() })).code, 'public')

    // The adaptation: identity confirmed, so any port on a private host is fine.
    const confirmed = await resolveFabricTrust({ ...oddPort, verified: true }, { ...opts, request: fakeRequest({ '/v1/pki/ca': ROOT_A }) })

    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.source, 'tofu')
  })

  it('refuses a first contact that is not a usable CA', async () => {
    const { opts } = trustOpts()
    const cases = [
      [{}, 'unreachable'],
      [{ '/v1/pki/ca': res({ ok: false, status: 0, error: 'connect ECONNREFUSED' }) }, 'unreachable'],
      [{ '/v1/pki/ca': res({ ok: false, status: 404, body: 'no such path' }) }, 'no_ca'],
      [{ '/v1/pki/ca': 'not a certificate at all' }, 'no_ca']
    ]

    for (const [handlers, code] of cases) {
      const out = await resolveFabricTrust(plane(), { ...opts, request: fakeRequest(handlers) })

      assert.equal(out.ok, false)
      assert.equal(out.code, code)
    }
  })

  it('reuses a pin without a word when the plane still serves it', async () => {
    const { opts, dir } = trustOpts()
    const notes = []

    persistTofuCA(opts.tofuFile, LAN, ROOT_A)

    const trust = await resolveFabricTrust(plane(), {
      ...opts,
      request: fakeRequest({ '/v1/pki/ca': ROOT_A }),
      warn: m => notes.push(m),
      note: m => notes.push(m)
    })

    assert.equal(trust.source, 'pin')
    assert.equal(trust.caPem, ROOT_A)
    assert.equal(fs.readFileSync(path.join(dir, 'cas', `${path.basename(trust.caFile)}`), 'utf8'), ROOT_A)
    assert.deepEqual(notes, [])
  })

  it('rejects a rotated CA — over the wire and over TLS — and says how to recover', async () => {
    const { opts } = trustOpts()

    persistTofuCA(opts.tofuFile, LAN, ROOT_A)

    const rotated = await resolveFabricTrust(plane(), { ...opts, request: fakeRequest({ '/v1/pki/ca': ROOT_B }) })
    const tlsRotated = await resolveFabricTrust(plane(), {
      ...opts,
      request: fakeRequest({ '/v1/pki/ca': res({ ok: false, status: 0, error: 'unable to verify the first certificate' }) })
    })

    for (const out of [rotated, tlsRotated]) {
      assert.equal(out.ok, false)
      assert.equal(out.code, 'rotated')
      assert.match(out.error, /no longer validates/)
      assert.match(out.error, /HOUDRY_FABRIC_REPIN/)
    }

    // PEM re-encoding is not a rotation.
    const { opts: reencoded } = trustOpts()

    persistTofuCA(reencoded.tofuFile, LAN, ROOT_A)

    const same = await resolveFabricTrust(plane(), {
      ...reencoded,
      request: fakeRequest({ '/v1/pki/ca': `noise\n${ROOT_A.replace(/\r\n/g, '\n')}\nnoise` })
    })

    assert.equal(same.source, 'pin')
  })

  it('keeps a pin through a plane that is simply down or silent on /v1/pki/ca', async () => {
    const { opts } = trustOpts()

    persistTofuCA(opts.tofuFile, LAN, ROOT_A)

    const down = []
    const transient = await resolveFabricTrust(plane(), {
      ...opts,
      warn: m => down.push(m),
      request: fakeRequest({ '/v1/pki/ca': res({ ok: false, status: 0, error: 'connect ECONNREFUSED 192.168.1.20:18080', code: 'ECONNREFUSED' }) })
    })

    assert.equal(transient.source, 'pin')
    assert.match(down.join(' '), /continuing with it/)

    const silent = []
    const noEndpoint = await resolveFabricTrust(plane(), {
      ...opts,
      warn: m => silent.push(m),
      request: fakeRequest({ '/v1/pki/ca': res({ ok: false, status: 404, body: '' }) })
    })

    assert.equal(noEndpoint.source, 'pin')
    assert.match(silent.join(' '), /HTTP 404/)
  })

  it('replaces a pin only when asked to', async () => {
    const { opts, dir } = trustOpts()

    persistTofuCA(opts.tofuFile, LAN, ROOT_A)

    const kept = await resolveFabricTrust(plane(), { ...opts, request: fakeRequest({ '/v1/pki/ca': ROOT_B }) })

    assert.equal(kept.code, 'rotated')

    const notes = []
    const repinned = await resolveFabricTrust(plane(), {
      ...opts,
      repin: true,
      request: fakeRequest({ '/v1/pki/ca': ROOT_B }),
      warn: m => notes.push(m),
      note: m => notes.push(m)
    })

    assert.equal(repinned.source, 'tofu')
    assert.equal(pinnedCAForOrigin(LAN, opts.tofuFile), ROOT_B)
    assert.equal(fs.readFileSync(path.join(dir, 'cas', path.basename(repinned.caFile)), 'utf8'), ROOT_B)
    assert.match(notes.join(' '), /re-pinning/)
  })

  it('prefers the local houdry home root when it really validates the origin', async () => {
    const { opts, dir } = trustOpts({ homeCAFile: ROOT_A })
    const request = fakeRequest({ '/.well-known/houdry.json': ROOT_A, '/v1/pki/ca': ROOT_A })
    const trust = await resolveFabricTrust(plane(), { ...opts, request })

    assert.equal(trust.source, 'local')
    assert.equal(fs.readFileSync(path.join(dir, 'cas', path.basename(trust.caFile)), 'utf8'), ROOT_A)
    // Only the verified path is trusted from home: the check names the origin.
    assert.ok(request.seen.some(call => call.url === `${LAN}/.well-known/houdry.json` && call.ca === ROOT_A))

    const { opts: bad } = trustOpts({ homeCAFile: ROOT_B })
    const fell = await resolveFabricTrust(plane(), { ...bad, request: fakeRequest({ '/v1/pki/ca': ROOT_A }), note: () => {} })

    assert.equal(fell.source, 'tofu')
  })
})

describe('resolveFabricCredential and fabricAuthHeaders', () => {
  it('sends a usable key, and nothing else', () => {
    assert.deepEqual(fabricAuthHeaders('tok-123'), { Authorization: 'Bearer tok-123' })
    assert.deepEqual(fabricAuthHeaders(''), {})
    assert.deepEqual(fabricAuthHeaders(undefined), {})
  })

  it('fails before launch when a tokened plane has no token', () => {
    const keyless = resolveFabricCredential(plane({ auth: true }), { env: {} })

    assert.equal(keyless.ok, false)
    assert.match(keyless.error, /houdry serve --token/)

    const placeholder = resolveFabricCredential(plane({ auth: true }), { env: { HOUDRY_FABRIC_KEY: 'changeme' } })

    assert.equal(placeholder.ok, false)

    const real = resolveFabricCredential(plane({ auth: true }), { env: { HOUDRY_FABRIC_KEY: ' 0011223344556677 ' } })

    assert.deepEqual(real, { ok: true, key: '0011223344556677', placeholder: false })
  })

  it('substitutes the placeholder for a plane that asks for no token', () => {
    assert.deepEqual(resolveFabricCredential(plane({ auth: false }), { env: {} }), { ok: true, key: PLACEHOLDER_FABRIC_KEY, placeholder: true })
  })
})

describe('parseModelIds', () => {
  it('reads both catalog shapes the fabric writes', () => {
    assert.deepEqual(parseModelIds('{"data":[{"id":"qwen2.5"},{"id":"auto"}]}'), ['qwen2.5', 'auto'])
    assert.deepEqual(parseModelIds('{"data":["a"," ","b"]}'), ['a', 'b'])
    assert.deepEqual(parseModelIds('["x","y"]'), ['x', 'y'])
    assert.deepEqual(parseModelIds('{"models":[]}'), [])
    assert.deepEqual(parseModelIds('this is not json'), [])
  })
})

describe('describeFabricError', () => {
  it('classifies the nested WriteError shape with the fix an operator needs', () => {
    const body = '{"error":{"message":"no suitable node for this model","type":"server_error","code":"no_suitable_node"}}'
    const out = describeFabricError(503, body)

    assert.equal(out.code, 'no_suitable_node')
    assert.equal(out.message, 'no suitable node for this model')
    assert.match(out.hint, /houdry gpu register/)
    assert.equal(out.retryable, true)
  })

  it('classifies the flat shape server.authorized() writes', () => {
    const out = describeFabricError(401, '{"error":"unauthorized"}')

    assert.equal(out.code, 'unauthorized')
    assert.equal(out.message, 'unauthorized')
    assert.match(out.hint, /HOUDRY_FABRIC_KEY/)
    assert.equal(out.retryable, false)
  })

  it('still says something when the answer is not JSON', () => {
    const out = describeFabricError(502, 'Bad Gateway from the proxy')

    assert.equal(out.code, '')
    assert.equal(out.message, 'Bad Gateway from the proxy')
    assert.match(out.hint, /worker/)
    assert.equal(describeFabricError(0, '').retryable, true)
    assert.equal(describeFabricError(400, '{}').retryable, false)
    assert.equal(describeFabricError(429, '').retryable, true)
  })

  it('names the tool-catalog mismatch the harness always trips', () => {
    assert.match(describeFabricError(400, '{"error":{"message":"x","code":"model_no_tools"}}').hint, /tool-capable model/)
  })
})

describe('listFabricModels', () => {
  it('keeps the Agent probe contract: ok, reachable, message, models — never a throw', async () => {
    const request = fakeRequest({ '/v1/models': '{"data":[{"id":"llama-3"}]}' })
    const ok = await listFabricModels({ api: `${LAN}/v1`, key: 'tok-123', request })

    assert.deepEqual(ok, { ok: true, code: '', reachable: true, message: '', models: ['llama-3'] })
    assert.deepEqual(request.seen[0].headers, { Accept: 'application/json', Authorization: 'Bearer tok-123' })

    const empty = await listFabricModels({ api: `${LAN}/v1`, request: fakeRequest({ '/v1/models': '{"data":[]}' }) })

    assert.deepEqual(empty, { ok: true, code: '', reachable: true, message: '', models: [] })

    const refused = await listFabricModels({ api: `${LAN}/v1`, request: fakeRequest({ '/v1/models': res({ ok: false, status: 401, body: '{"error":"unauthorized"}' }) }) })

    assert.equal(refused.ok, false)
    assert.equal(refused.reachable, true)
    assert.match(refused.message, /rejected the API key/)

    const gone = await listFabricModels({ api: `${LAN}/v1`, request: fakeRequest({ '/v1/models': res({ ok: false, status: 0, error: 'timeout' }) }) })

    assert.equal(gone.reachable, false)
    assert.match(gone.message, /Could not reach/)

    const broken = await listFabricModels({ api: `${LAN}/v1`, request: fakeRequest({ '/v1/models': res({ ok: false, status: 500, body: '{"error":{"message":"boom","code":"runtime_error"}}' }) }) })

    assert.match(broken.message, /HTTP 500: boom/)
  })
})

describe('fabricChatCompletion', () => {
  const reply = '{"id":"cmpl-1","model":"qwen2.5","choices":[{"message":{"role":"assistant","content":"PONG"},"finish_reason":"stop"}],"usage":{"total_tokens":38}}'

  it('writes the body the fabric request struct reads', async () => {
    const request = fakeRequest({ '/v1/chat/completions': reply })
    const out = await fabricChatCompletion({
      api: `${LAN}/v1/`,
      model: FABRIC_MODEL_AUTO,
      messages: [{ role: 'user', content: 'ping' }],
      key: 'tok-123',
      maxTokens: 512,
      temperature: 0.2,
      tools: [{ type: 'function' }],
      request
    })

    assert.equal(out.ok, true)
    assert.equal(out.content, 'PONG')
    assert.equal(out.finishReason, 'stop')
    assert.equal(out.usage.total_tokens, 38)

    const sent = request.seen[0]

    assert.equal(sent.url, `${LAN}/v1/chat/completions`)
    assert.equal(sent.method, 'POST')
    assert.deepEqual(JSON.parse(sent.body), {
      model: 'auto',
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      temperature: 0.2,
      max_tokens: 512,
      tools: [{ type: 'function' }]
    })
    assert.equal(sent.headers.Authorization, 'Bearer tok-123')
  })

  it('reads content as text or parts, and reports tool calls', async () => {
    const parts = '{"choices":[{"message":{"content":[{"type":"text","text":"he"},{"type":"text","text":"llo"}]}}]}'
    const tools = '{"choices":[{"message":{"content":"","tool_calls":[{"id":"call-1"}]}}]}'

    assert.equal((await fabricChatCompletion({ api: `${LAN}/v1`, messages: [], request: fakeRequest({ '/v1/chat/completions': parts }) })).content, 'hello')
    assert.deepEqual((await fabricChatCompletion({ api: `${LAN}/v1`, messages: [], request: fakeRequest({ '/v1/chat/completions': tools }) })).toolCalls, [{ id: 'call-1' }])
  })

  it('turns a fabric failure into its code and hint', async () => {
    const refused = await fabricChatCompletion({
      api: `${LAN}/v1`,
      messages: [],
      request: fakeRequest({ '/v1/chat/completions': res({ ok: false, status: 401, body: '{"error":"unauthorized"}' }) })
    })

    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'unauthorized')
    assert.match(refused.hint, /houdry serve --token/)

    const unreachable = await fabricChatCompletion({ api: `${LAN}/v1`, messages: [], request: fakeRequest({ '/v1/chat/completions': res({ ok: false, status: 0, error: 'socket hang up' }) }) })

    assert.equal(unreachable.code, 'unreachable')
    assert.equal(unreachable.retryable, true)

    assert.equal((await fabricChatCompletion({ api: `${LAN}/v1`, messages: [], request: fakeRequest({ '/v1/chat/completions': '<html>502</html>' }) })).code, 'bad_json')
    assert.equal((await fabricChatCompletion({ api: `${LAN}/v1`, messages: [], request: fakeRequest({ '/v1/chat/completions': '{"choices":[]}' }) })).code, 'no_choices')
  })
})

describe('connectFabric', () => {
  function connected(over = {}) {
    const dir = tempDir()

    return {
      dir,
      args: {
        env: { HOUDRY_FABRIC_URL: 'https://192.168.1.20:18080' },
        tofuFile: path.join(dir, 'houdry-tofu-ca.json'),
        homeCAFile: '',
        identity: identityFake(),
        request: fakeRequest({
          '/.well-known/houdry.json': '{"houdry":"control-plane","v":1}',
          '/v1/pki/ca': ROOT_A,
          '/v1/models': '{"data":[{"id":"qwen2.5-coder"},{"id":"llama-3.2"}]}'
        }),
        ...over
      }
    }
  }

  it('returns the launcher configuration for a plane it can talk to', async () => {
    const { dir, args } = connected()
    const out = await connectFabric(args)

    assert.equal(out.ok, true)
    assert.equal(out.api, 'https://192.168.1.20:18080/v1')
    assert.equal(out.caFile, fabricPinFile(dir, LAN))
    assert.deepEqual(out.models, ['qwen2.5-coder', 'llama-3.2'])
    assert.equal(out.exportKey, PLACEHOLDER_FABRIC_KEY)
    assert.deepEqual(out.config, {
      HOUDRY_FABRIC_URL: 'https://192.168.1.20:18080/v1',
      HOUDRY_FABRIC_MODELS: 'qwen2.5-coder,llama-3.2',
      NODE_EXTRA_CA_CERTS: fabricPinFile(dir, LAN),
      HOUDRY_FABRIC_KEY: PLACEHOLDER_FABRIC_KEY
    })
  })

  it('exports the placeholder for a keyless plane but never a real token', async () => {
    const keyless = await connectFabric(connected().args)

    assert.equal(keyless.placeholder, true)
    assert.equal(keyless.exportKey, PLACEHOLDER_FABRIC_KEY)
    assert.equal(keyless.config.HOUDRY_FABRIC_KEY, PLACEHOLDER_FABRIC_KEY)

    const { args } = connected()
    const tokened = await connectFabric({ ...args, env: { ...args.env, HOUDRY_FABRIC_KEY: '0011223344556677' } })

    assert.equal(tokened.placeholder, false)
    assert.equal(tokened.exportKey, '')
    assert.equal('HOUDRY_FABRIC_KEY' in tokened.config, false)
  })

  it('starts a router that lists nothing by asking it for auto', async () => {
    const { args } = connected()
    const out = await connectFabric({
      ...args,
      request: fakeRequest({
        '/.well-known/houdry.json': '{"houdry":"control-plane","v":1}',
        '/v1/pki/ca': ROOT_A,
        '/v1/models': '{"data":[]}'
      })
    })

    assert.deepEqual(out.models, [FABRIC_MODEL_AUTO])
    assert.equal(out.config.HOUDRY_FABRIC_MODELS, FABRIC_MODEL_AUTO)
    assert.match(out.notes.join(' '), /listed no models/)
  })

  it('stops before dsh starts when the plane answers nothing, or refuses the key', async () => {
    const { args } = connected()
    const silent = await connectFabric({
      ...args,
      request: fakeRequest({
        '/v1/pki/ca': ROOT_A,
        '/v1/models': res({ ok: false, status: 0, error: 'connect ECONNREFUSED' })
      })
    })

    assert.equal(silent.ok, false)
    assert.equal(silent.code, 'unreachable')
    assert.match(silent.error, /Could not reach/)
    assert.match(silent.error, /houdry serve/)

    const refused = await connectFabric({
      ...args,
      request: fakeRequest({
        '/v1/pki/ca': ROOT_A,
        '/v1/models': res({ ok: false, status: 401, body: '{"error":"unauthorized"}' })
      })
    })

    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'unauthorized')
    assert.match(refused.error, /rejected the API key/)
    assert.match(refused.error, /houdry serve --token/)
  })

  it('stops with the reason when the plane, the trust, or the token fails', async () => {
    const noPlane = await connectFabric({ env: {}, discover: async () => [], identity: () => false, request: fakeRequest() })

    assert.equal(noPlane.ok, false)
    assert.equal(noPlane.code, 'plane')

    const untrusted = await connectFabric({
      env: { HOUDRY_FABRIC_URL: 'https://fabric.example.com:18080' },
      tofuFile: path.join(tempDir(), 'houdry-tofu-ca.json'),
      homeCAFile: '',
      identity: () => false,
      request: fakeRequest()
    })

    assert.equal(untrusted.ok, false)
    assert.equal(untrusted.code, 'public')

    const needsToken = await connectFabric({
      ...connected().args,
      env: {},
      discover: async () => [lanEndpoint({ auth: true })],
      request: fakeRequest({ '/v1/pki/ca': ROOT_A })
    })

    assert.equal(needsToken.ok, false)
    assert.equal(needsToken.code, 'auth')
    assert.match(needsToken.error, /HOUDRY_FABRIC_KEY/)
  })
})
