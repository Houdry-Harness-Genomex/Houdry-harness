// The document that decides what the `houdry` route serves, and this module's
// authority over it.
//
// Everything here runs against a throwaway harness home: the patch document is
// `$DSH_HOME/profiles/web/cordis.patch.yml`, so each case builds its own home
// and trust directory and never looks at the operator's. The writer is judged
// by the same rule the product's own ConfigEditor follows — siblings, comments
// and `!!js` expressions survive an edit byte for byte, and a document this
// module does not own is refused, never rewritten.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  decideRouteCycle,
  fabricProfilePatchPath,
  FABRIC_MODEL_AUTO,
  HOUDRY_ROUTE_DEFAULTS,
  houdryProviderConfig,
  isFabricRouteApi,
  isLoopbackRouteApi,
  readFabricRoute,
  resolveFabricProfilePatchPath,
  routeModelsChanged,
  routeModelsFromList,
  ROUTE_PLUGIN_ID,
  sameRouteApi,
  writeFabricRoute
} from '../houdry-fabric-patch.mjs'

const LAN = 'https://192.168.1.20:18081/v1'
const OTHER_LAN = 'https://10.0.0.9:18080/v1'

/** A harness home and trust directory belonging to no operator. */
function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-patch-home-'))
  const tofu = fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-patch-tofu-'))

  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(tofu, { recursive: true, force: true })
  })

  return {
    home,
    tofu,
    patchPath: path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
    env: { DSH_HOME: home, HOUDRY_FABRIC_TOFU_DIR: tofu }
  }
}

function writeDocument(box, text) {
  fs.mkdirSync(path.dirname(box.patchPath), { recursive: true })
  fs.writeFileSync(box.patchPath, text)

  return text
}

/** A document carrying the fabric route plus a neighbor entry nothing may touch. */
const DOCUMENT_WITH_NEIGHBORS = [
  '# an operator comment about this profile',
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      houdry:',
  '        displayName: Houdry Fabric',
  '        baseURL: https://192.168.1.20:18081/v1',
  '        apiKeyEnv: HOUDRY_FABRIC_KEY',
  '        models:',
  '          - id: a',
  '          - id: b',
  '      other:',
  '        baseURL: !!js process.env.OTHER_PLANE_URL',
  '- id: something-else',
  '  config:',
  '    theme: dark',
  ''
].join('\n')

describe('the profile patch path', () => {
  it('is the watched document of the web profile under the home it is given', () => {
    assert.equal(
      fabricProfilePatchPath({ DSH_HOME: 'C:\\homes\\one' }, 'D:\\homes\\two'),
      path.join('D:\\homes\\two', 'profiles', 'web', 'cordis.patch.yml')
    )
  })

  it('falls back to DSH_HOME and refuses to guess', () => {
    assert.equal(
      fabricProfilePatchPath({ DSH_HOME: '  C:\\homes\\one  ' }),
      path.join('C:\\homes\\one', 'profiles', 'web', 'cordis.patch.yml')
    )

    assert.throws(() => fabricProfilePatchPath({}), /needs a harness home/)
    assert.throws(() => fabricProfilePatchPath({ DSH_HOME: '   ' }), /needs a harness home/)
  })

  it('resolves through the product home resolver', async (t) => {
    const box = sandbox(t)
    const resolved = await resolveFabricProfilePatchPath(box.env)

    assert.equal(resolved, box.patchPath)
  })
})

describe('reading the route the document serves', () => {
  it('reads null when there is nothing to read', async (t) => {
    const box = sandbox(t)

    assert.equal(readFabricRoute(box.patchPath), null)

    writeDocument(box, '- id: something-else\n  config: { theme: dark }\n')

    assert.equal(readFabricRoute(box.patchPath), null)

    writeDocument(box, '- id: llm-pi-ai\n  config:\n    providers:\n      other: {}\n')

    assert.equal(readFabricRoute(box.patchPath), null)
  })

  it('reads the address, the catalog in document order, and the name', async (t) => {
    const box = sandbox(t)
    writeDocument(box, DOCUMENT_WITH_NEIGHBORS)

    assert.deepEqual(readFabricRoute(box.patchPath), {
      baseURL: 'https://192.168.1.20:18081/v1',
      models: ['a', 'b'],
      displayName: 'Houdry Fabric',
      configurable: true
    })
  })

  it('reads a !!js baseURL as someone else\'s route, and a missing one as unfinished', async (t) => {
    const box = sandbox(t)
    writeDocument(box, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      houdry:',
      '        displayName: Handwritten',
      '        baseURL: !!js process.env.MY_PLANE_URL',
      '        models: []',
      ''
    ].join('\n'))

    const computed = readFabricRoute(box.patchPath)

    assert.equal(computed.configurable, false)
    assert.equal(computed.baseURL, '')
    assert.equal(computed.displayName, 'Handwritten')

    writeDocument(box, '- id: llm-pi-ai\n  config:\n    providers:\n      houdry:\n        displayName: Bare\n')

    const bare = readFabricRoute(box.patchPath)

    assert.equal(bare.configurable, true)
    assert.equal(bare.baseURL, '')
  })

  it('reads a malformed document as the error it is', async (t) => {
    const box = sandbox(t)
    writeDocument(box, '- id: llm-pi-ai\n  config: [broken\n')

    assert.throws(() => readFabricRoute(box.patchPath), /does not parse as YAML/)
  })
})

describe('writing the route', () => {
  it('creates the entry when the document has none', async (t) => {
    const box = sandbox(t)

    const written = await writeFabricRoute({ patchPath: box.patchPath, url: LAN, models: ['a', FABRIC_MODEL_AUTO] })

    assert.equal(written.ok, true)
    assert.equal(written.changed, true)
    assert.deepEqual(readFabricRoute(box.patchPath), {
      baseURL: LAN,
      models: ['a', FABRIC_MODEL_AUTO],
      displayName: HOUDRY_ROUTE_DEFAULTS.defaultDisplayName,
      configurable: true
    })

    const text = fs.readFileSync(box.patchPath, 'utf8')

    assert.match(text, new RegExp(`- id: ${ROUTE_PLUGIN_ID}`))
    assert.match(text, /supportsDeveloperRole: false/)
    assert.match(text, /maxTokensField: max_tokens/)
  })

  it('writes the same thing once and then never touches the file again', async (t) => {
    const box = sandbox(t)

    await writeFabricRoute({ patchPath: box.patchPath, url: LAN, models: ['a'] })
    const afterFirst = fs.readFileSync(box.patchPath, 'utf8')

    const again = await writeFabricRoute({ patchPath: box.patchPath, url: LAN, models: ['a'] })

    assert.equal(again.ok, true)
    assert.equal(again.changed, false)
    assert.equal(fs.readFileSync(box.patchPath, 'utf8'), afterFirst)
  })

  it('changes the route and nothing else: siblings, neighbors, comments and !!js all survive', async (t) => {
    const box = sandbox(t)
    const before = writeDocument(box, DOCUMENT_WITH_NEIGHBORS)

    const written = await writeFabricRoute({ patchPath: box.patchPath, url: OTHER_LAN, models: ['q'] })

    assert.equal(written.ok, true)
    assert.equal(written.changed, true)

    const text = fs.readFileSync(box.patchPath, 'utf8')

    assert.match(text, /baseURL: https:\/\/10\.0\.0\.9:18080\/v1/)
    assert.match(text, /# an operator comment about this profile/)
    assert.match(text, /- id: something-else/)
    assert.match(text, /theme: dark/)
    assert.match(text, /!!js process\.env\.OTHER_PLANE_URL/)

    const read = readFabricRoute(box.patchPath)

    assert.equal(read.baseURL, OTHER_LAN)
    assert.deepEqual(read.models, ['q'])

    // The document is re-serialized, so equality with the original text is not
    // the claim — the claim is that everything outside the route still parses
    // to what it parsed to before.
    assert.notEqual(text, before)
    assert.deepEqual(readFabricRoute(box.patchPath), {
      baseURL: OTHER_LAN,
      models: ['q'],
      displayName: HOUDRY_ROUTE_DEFAULTS.defaultDisplayName,
      configurable: true
    })
  })

  it('re-tags a single-key __jsExpr map back to !!js on the way out', async (t) => {
    const box = sandbox(t)
    writeDocument(box, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      houdry:',
      '        baseURL: https://192.168.1.20:18081/v1',
      '        models:',
      '          - id: a',
      '      other:',
      '        baseURL:',
      '          __jsExpr: process.env.OTHER_PLANE_URL',
      ''
    ].join('\n'))

    const written = await writeFabricRoute({ patchPath: box.patchPath, url: LAN, models: ['a'] })

    assert.equal(written.ok, true)
    assert.match(fs.readFileSync(box.patchPath, 'utf8'), /!!js process\.env\.OTHER_PLANE_URL/)
  })

  it('refuses a route whose baseURL is a !!js expression', async (t) => {
    const box = sandbox(t)
    const before = writeDocument(box, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      houdry:',
      '        baseURL: !!js process.env.MY_PLANE_URL',
      '        models: []',
      ''
    ].join('\n'))

    const written = await writeFabricRoute({ patchPath: box.patchPath, url: LAN, models: ['a'] })

    assert.deepEqual(written, {
      ok: false,
      changed: false,
      error: `${box.patchPath} computes the houdry baseURL with a !!js expression, which this module does not overwrite`,
      reason: 'managed'
    })
    assert.equal(fs.readFileSync(box.patchPath, 'utf8'), before)
  })

  it('fills an absent baseURL but refuses a document it cannot parse', async (t) => {
    const box = sandbox(t)
    writeDocument(box, '- id: llm-pi-ai\n  config:\n    providers:\n      houdry:\n        displayName: Bare\n')

    const filled = await writeFabricRoute({ patchPath: box.patchPath, url: LAN, models: ['a'] })

    assert.equal(filled.ok, true)
    assert.equal(readFabricRoute(box.patchPath).baseURL, LAN)

    const broken = writeDocument(box, '- id: llm-pi-ai\n  config: [broken\n')
    const refused = await writeFabricRoute({ patchPath: box.patchPath, url: LAN, models: ['a'] })

    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'parse')
    assert.match(refused.error, /does not parse as YAML/)
    assert.equal(fs.readFileSync(box.patchPath, 'utf8'), broken)

    writeDocument(box, 'not: a sequence\n')
    const notAList = await writeFabricRoute({ patchPath: box.patchPath, url: LAN, models: ['a'] })

    assert.equal(notAList.reason, 'parse')
    assert.match(notAList.error, /not a YAML sequence/)
  })

  it('keeps the document readable by its owner alone where the platform has owners', { skip: process.platform === 'win32' ? 'Windows has no POSIX permission semantics' : false }, async (t) => {
    const box = sandbox(t)

    await writeFabricRoute({ patchPath: box.patchPath, url: LAN, models: ['a'] })

    assert.equal(fs.statSync(box.patchPath).mode & 0o077, 0)
    assert.equal(fs.statSync(path.dirname(box.patchPath)).mode & 0o077, 0)
  })
})

describe('what counts as this module\'s route', () => {
  it('claims https to a private or loopback host, whatever the port', () => {
    assert.equal(isFabricRouteApi('https://192.168.1.20:18081/v1'), true)
    assert.equal(isFabricRouteApi('https://127.0.0.1:18080/v1'), true)
    assert.equal(isFabricRouteApi('https://10.0.0.9:8090/v1'), true)
    assert.equal(isFabricRouteApi('http://192.168.1.20:18081/v1'), false)
    assert.equal(isFabricRouteApi('https://fabric.example.com:18080/v1'), false)
    assert.equal(isFabricRouteApi('nonsense'), false)
    assert.equal(isFabricRouteApi(''), false)
    assert.equal(isFabricRouteApi(undefined), false)
  })

  it('names loopback so it is never written from discovery', () => {
    assert.equal(isLoopbackRouteApi('https://127.0.0.1:18080/v1'), true)
    assert.equal(isLoopbackRouteApi('https://localhost:18081/v1'), true)
    assert.equal(isLoopbackRouteApi('https://[::1]:18080/v1'), true)
    assert.equal(isLoopbackRouteApi('https://192.168.1.20:18081/v1'), false)
  })

  it('collapses two spellings of one plane, and separates two planes', () => {
    assert.equal(sameRouteApi('https://192.168.1.20:18081', LAN), true)
    assert.equal(sameRouteApi('http://192.168.1.20:18081/v1/', LAN), true)
    assert.equal(sameRouteApi(LAN, OTHER_LAN), false)
    assert.equal(sameRouteApi('', LAN), false)
    assert.equal(sameRouteApi(LAN, undefined), false)
  })

  it('treats catalog order as a change and parses the launcher MODELS line', () => {
    assert.equal(routeModelsChanged(['a', 'b'], ['b', 'a']), true)
    assert.equal(routeModelsChanged(['a', 'b'], ['a', 'b']), false)
    assert.equal(routeModelsChanged(['a'], []), true)
    assert.equal(routeModelsChanged(null, []), false)

    assert.deepEqual(routeModelsFromList(' a , b ,, '), ['a', 'b'])
    assert.deepEqual(routeModelsFromList(''), [])
    assert.deepEqual(routeModelsFromList(undefined), [])
  })

  it('builds the provider entry the overlay used to carry', () => {
    assert.deepEqual(
      houdryProviderConfig({ url: LAN, models: ['a'], displayName: '' }),
      {
        displayName: HOUDRY_ROUTE_DEFAULTS.defaultDisplayName,
        api: HOUDRY_ROUTE_DEFAULTS.api,
        baseURL: LAN,
        apiKeyEnv: HOUDRY_ROUTE_DEFAULTS.apiKeyEnv,
        compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        defaultContextWindow: 8192,
        defaultMaxTokens: 2048,
        models: [{ id: 'a' }]
      }
    )
  })
})

describe('one reconnect decision', () => {
  const saved = { baseURL: LAN, models: ['a', 'b'], displayName: 'Houdry Fabric', configurable: true }
  const found = { api: LAN, models: ['a', 'b'], displayName: 'Houdry Fabric' }

  it('adopts when there is no route yet, and when the network answers with another plane', () => {
    assert.deepEqual(decideRouteCycle({ saved: null, discovered: found }), {
      action: 'adopt',
      api: LAN,
      models: ['a', 'b'],
      displayName: 'Houdry Fabric'
    })

    assert.equal(decideRouteCycle({ saved, discovered: { ...found, api: OTHER_LAN } }).action, 'adopt')
  })

  it('carries the name the operator gave the route across an adopt, and the plane name when the route has none', () => {
    const renamed = { ...saved, displayName: 'Studio GPU' }
    const another = { ...found, api: OTHER_LAN, displayName: 'houdry-7' }

    assert.equal(decideRouteCycle({ saved: renamed, discovered: another }).displayName, 'Studio GPU')
    assert.equal(decideRouteCycle({ saved: { ...saved, displayName: '' }, discovered: another }).displayName, 'houdry-7')
    assert.equal(decideRouteCycle({ saved: null, discovered: { ...found, displayName: '' } }).displayName, '')
  })

  it('adopts a route that has no address yet, and skips routes it does not own', () => {
    const bare = { baseURL: '', models: [], displayName: 'Bare', configurable: true }

    assert.equal(decideRouteCycle({ saved: bare, discovered: found }).action, 'adopt')

    const computed = { baseURL: '', models: [], displayName: 'Handwritten', configurable: false }

    assert.equal(decideRouteCycle({ saved: computed, discovered: found }).action, 'skip')

    const foreign = { baseURL: 'https://fabric.example.com:18080/v1', models: [], displayName: '', configurable: true }

    assert.equal(decideRouteCycle({ saved: foreign, discovered: found }).action, 'skip')
  })

  it('refreshes a changed catalog and keeps an unchanged one', () => {
    assert.equal(decideRouteCycle({ saved, discovered: { ...found, models: ['a', 'c'] } }).action, 'refresh')
    assert.equal(decideRouteCycle({ saved, discovered: found }).action, 'keep')
  })

  it('keeps a reachable non-loopback plane when nothing is discovered, and never a loopback one', () => {
    assert.deepEqual(
      decideRouteCycle({ saved, discovered: null, savedReachable: true }),
      { action: 'keep', api: LAN, models: ['a', 'b'] }
    )

    const loopback = { baseURL: 'https://127.0.0.1:18080/v1', models: ['a'], displayName: '', configurable: true }

    assert.equal(decideRouteCycle({ saved: loopback, discovered: null, savedReachable: true }).action, 'retry')
  })

  it('retries when nothing reliable was learned', () => {
    assert.equal(decideRouteCycle({ saved: null, discovered: null }).action, 'retry')
    assert.equal(decideRouteCycle({ saved, discovered: null, savedReachable: false }).action, 'retry')
  })
})
