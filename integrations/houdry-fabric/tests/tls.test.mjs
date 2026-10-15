// The trust rules ported from the Agent's electron/houdry-tls.ts and
// hermes_cli/houdry_tls.py. What is pinned, where, and for whom — and the one
// bound that matters most: an unverified fetch-and-trust may only ever happen
// against a private address.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  HOUDRY_PORTS,
  applyHoudryCATrust,
  defaultTofuFile,
  houdryHttpsGet,
  houdryHttpsRequest,
  httpsAgentForCA,
  isHoudryLanHttps,
  loadTofuStore,
  persistTofuCA,
  pinRemoteCA,
  pinnedCAForOrigin,
  rewriteHoudryHttps,
  tofuStorePath
} from '../houdry-tls.mjs'
import { ROOT_A, ROOT_B } from './fixtures.mjs'

function tempFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-tls-')), name)
}

describe('rewriteHoudryHttps', () => {
  it('upgrades http and trims trailing slashes', () => {
    assert.equal(rewriteHoudryHttps('http://10.0.0.5:8080/'), 'https://10.0.0.5:8080')
    assert.equal(rewriteHoudryHttps('  https://a:18080///  '), 'https://a:18080')
    assert.equal(rewriteHoudryHttps('https://a:18080'), 'https://a:18080')
  })
})

describe('isHoudryLanHttps', () => {
  it('accepts a private host on a port houdry serve uses', () => {
    for (const port of HOUDRY_PORTS) {
      assert.equal(isHoudryLanHttps(`https://192.168.1.10:${port}`), true)
    }

    assert.equal(isHoudryLanHttps('https://10.0.0.5:8090'), true)
    assert.equal(isHoudryLanHttps('https://172.16.0.9:8080'), true)
    assert.equal(isHoudryLanHttps('https://127.0.0.1:18080'), true)
  })

  it('refuses a public host even on a Houdry port', () => {
    assert.equal(isHoudryLanHttps('https://93.184.216.34:18080'), false)
    assert.equal(isHoudryLanHttps('https://plane.example.com:18080'), false)
  })

  it('refuses http and malformed URLs', () => {
    assert.equal(isHoudryLanHttps('http://192.168.1.10:18080'), false)
    assert.equal(isHoudryLanHttps('not a url'), false)
    assert.equal(isHoudryLanHttps(''), false)
  })

  it('refuses a private host on an unrelated port, unless the plane proved itself', () => {
    // The port list is only a proxy for "this is houdry serve"; a caller that
    // read /.well-known/houdry.json knows, and a public host stays refused.
    assert.equal(isHoudryLanHttps('https://192.168.1.10:34567'), false)
    assert.equal(isHoudryLanHttps('https://192.168.1.10:34567', HOUDRY_PORTS, { confirmed: true }), true)
    assert.equal(isHoudryLanHttps('https://93.184.216.34:34567', HOUDRY_PORTS, { confirmed: true }), false)
  })
})

describe('tofu store', () => {
  it('keeps one CA per origin and reports its fingerprint', () => {
    const file = tempFile('houdry-tofu-ca.json')
    const first = persistTofuCA(file, 'https://192.168.1.10:18080', ROOT_A)
    persistTofuCA(file, 'https://192.168.1.11:18080', ROOT_B)

    const store = loadTofuStore(file)

    assert.equal(Object.keys(store).length, 2)
    assert.equal(store['https://192.168.1.10:18080'].pem, ROOT_A)
    assert.equal(store['https://192.168.1.10:18080'].fingerprint, first)
    assert.equal(pinnedCAForOrigin('https://192.168.1.10:18080', file), ROOT_A)
    assert.equal(pinnedCAForOrigin('https://192.168.1.99:18080', file), '')
  })

  it('overwrites an origin on re-pin and survives a corrupt file', () => {
    const file = tempFile('houdry-tofu-ca.json')

    persistTofuCA(file, 'https://a:18080', ROOT_A)
    persistTofuCA(file, 'https://a:18080', ROOT_B)

    assert.equal(pinnedCAForOrigin('https://a:18080', file), ROOT_B)

    fs.writeFileSync(file, '{not json')
    assert.deepEqual(loadTofuStore(file), {})
    assert.equal(pinnedCAForOrigin('https://a:18080', file), '')
  })

  it('is missing-safe', () => {
    assert.deepEqual(loadTofuStore(tempFile('absent.json')), {})
    assert.equal(pinnedCAForOrigin('https://a:18080', ''), '')
  })

  it('defaults under its own home, not the Agent userData', () => {
    const file = defaultTofuFile({ HOUDRY_FABRIC_TOFU_DIR: '/tmp/houdry-dsh' })

    assert.equal(file, tofuStorePath('/tmp/houdry-dsh'))
    assert.ok(file.endsWith('houdry-tofu-ca.json'))
    assert.ok(defaultTofuFile({}, '/home/ops').startsWith(path.join('/home/ops', '.houdry-dsh')))
  })
})

describe('httpsAgentForCA', () => {
  it('verifies only when it has a root to verify against', () => {
    // https.Agent keeps its tls.connect options, not the values as own fields.
    assert.equal(httpsAgentForCA(ROOT_A).options.rejectUnauthorized, true)
    assert.equal(httpsAgentForCA('').options.rejectUnauthorized, false)
    assert.equal(httpsAgentForCA(ROOT_A, true).options.rejectUnauthorized, false)
  })
})

describe('applyHoudryCATrust', () => {
  it('writes the PEM and points every trust variable at it', () => {
    const dest = tempFile('agent-ca.crt')
    const env = {}

    applyHoudryCATrust(ROOT_A, dest, env)

    assert.equal(fs.readFileSync(dest, 'utf8'), ROOT_A)
    assert.deepEqual(
      { SSL_CERT_FILE: env.SSL_CERT_FILE, REQUESTS_CA_BUNDLE: env.REQUESTS_CA_BUNDLE, NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS },
      { SSL_CERT_FILE: dest, REQUESTS_CA_BUNDLE: dest, NODE_EXTRA_CA_CERTS: dest }
    )
  })

  it('leaves the environment alone for an empty PEM', () => {
    const env = {}

    applyHoudryCATrust('  ', tempFile('unused.crt'), env)

    assert.deepEqual(env, {})
  })
})

describe('pinRemoteCA', () => {
  it('stores the CA the plane serves', async () => {
    const file = tempFile('houdry-tofu-ca.json')
    const pem = await pinRemoteCA('https://192.168.1.10:18080', {
      tofuFile: file,
      fetchImpl: async () => ({ ok: true, status: 200, body: ROOT_A })
    })

    assert.equal(pem, ROOT_A)
    assert.equal(pinnedCAForOrigin('https://192.168.1.10:18080', file), ROOT_A)
  })

  it('keeps nothing when the answer is not a certificate', async () => {
    const file = tempFile('houdry-tofu-ca.json')
    const pem = await pinRemoteCA('https://192.168.1.10:18080', {
      tofuFile: file,
      fetchImpl: async () => ({ ok: true, status: 200, body: '<html>nope</html>' })
    })

    assert.equal(pem, '')
    assert.deepEqual(loadTofuStore(file), {})
  })

  it('is a no-op without a store to write to', async () => {
    const pem = await pinRemoteCA('https://192.168.1.10:18080', { fetchImpl: async () => ({ ok: true, status: 200, body: ROOT_A }) })

    assert.equal(pem, '')
  })
})

describe('the never-throw transport', () => {
  it('resolves a failed GET as an unusable answer', async () => {
    // Port 1 is not a control plane; the point is that this cannot reject.
    const res = await houdryHttpsGet('https://127.0.0.1:1/.well-known/houdry.json', { timeoutMs: 500, tofuFile: '' })

    assert.equal(res.ok, false)
    assert.equal(res.status, 0)
    assert.equal(res.body, '')
  })

  it('resolves a failed POST the same way, but says why', async () => {
    const res = await houdryHttpsRequest('https://127.0.0.1:1/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      timeoutMs: 500,
      tofuFile: ''
    })

    assert.equal(res.ok, false)
    assert.equal(res.status, 0)
    assert.ok(res.error)
  })

  it('rejects an unparseable URL without throwing', async () => {
    const res = await houdryHttpsRequest('not a url', { tofuFile: '' })

    assert.equal(res.ok, false)
    assert.equal(res.status, 0)
    assert.ok(res.error)
  })
})
