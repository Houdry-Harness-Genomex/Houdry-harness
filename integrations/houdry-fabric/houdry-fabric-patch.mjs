// The document that decides what the `houdry` route serves, and who may rewrite
// it. Ported from the Houdry Agent's control-plane reconnect — the decision
// table is `src/lib/control-plane-reconnect.ts`, the always-on loop it feeds is
// `use-control-plane-boot.ts`, and this module is the write side of both.
//
// The Agent rewrote its saved endpoint in application state and let the app
// re-resolve. dsh has a stricter rule, stated in its own discovery module:
// nothing but configuration decides what a route serves. The configuration that
// can change under a running server is the profile's patch document —
// `$DSH_HOME/profiles/web/cordis.patch.yml`. The harness watches that file,
// re-reads it, and re-applies the LLM plugin, which publishes
// `llm/adapters-updated` that the browser model picker refreshes on. So the
// whole Agent flow — boot connect, venue change, model refresh — lands here as
// one operation: rewrite the `providers.houdry` entry, and the harness does the
// rest.
//
// The launcher stopped carrying the route in a `--patch` overlay for this
// reason: an overlay is parsed once at boot and never watched, and its entry
// config would replace this document's on every recompose, silencing both the
// Models page and this module. The profile document is the one channel every
// writer — the page, the launcher, this watcher — already shares.
//
// Writes mirror `packages/boot/config-editor` (the service behind the Models
// page's own saves): parse with the `!!js` tag preserved, edit only the route's
// node, keep the lock the page uses, and replace atomically. A document this
// module cannot parse is refused, never rewritten — the page's edits and a
// hand-written `!!js` baseURL are someone else's work, and clobbering them to
// record an address would trade their config for our convenience.

import fs from 'node:fs'
import path from 'node:path'

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { isPrivateOrLoopback } from './houdry-tls.mjs'
import { fabricApiOf } from './houdry-connection.mjs'

/** The profile the fabric launchers start; its document is the only one watched. */
export const FABRIC_PROFILE_NAME = 'web'

/** The plugin entry and route key this integration owns inside that document. */
export const ROUTE_PLUGIN_ID = 'llm-pi-ai'
export const ROUTE_PLUGIN_NAME = '@deepseek-ai/dsh-llm-pi-ai'
export const HOUDRY_ROUTE_KEY = 'houdry'

/** When the plane lists nothing, the router still answers this id; the launcher records it so the route materializes. */
export const FABRIC_MODEL_AUTO = 'auto'

/** The catalog capacities the fabric cannot disclose; carried over from the overlay verbatim. */
export const HOUDRY_ROUTE_DEFAULTS = {
  defaultDisplayName: 'Houdry Fabric',
  api: 'openai-completions',
  apiKeyEnv: 'HOUDRY_FABRIC_KEY',
  defaultContextWindow: 8192,
  defaultMaxTokens: 2048
}

// The product's own YAML engine, reached through the package that edits this
// same document (config-editor), so the parser, the tag handling and the
// version are the ones the running server uses. Before `pnpm build` has
// produced `lib/`, this import fails and every write refuses with that reason —
// losing the live channel, never corrupting a document.
let yamlModule

function loadYaml() {
  if (yamlModule === undefined) {
    const entry = fileURLToPath(import.meta.resolve('../../packages/boot/config-editor/lib/index.js'))

    yamlModule = createRequire(entry)('yaml')
  }

  return yamlModule
}

async function loadWriteModules() {
  const [atomicWrite, homePaths] = await Promise.all([
    import('../../packages/util/atomic-write/lib/index.js'),
    import('../../packages/util/home-paths/lib/index.js')
  ])

  return { withFileLock: atomicWrite.withFileLock, writeFileAtomic: atomicWrite.writeFileAtomic, resolveDshHome: homePaths.resolveDshHome }
}

/** Same wait the credential writer uses: a launch must not lose to a held lock. */
const DOCUMENT_LOCK_WAIT_MS = 30_000

/** Preserved verbatim in edits, like the Models page's own writer keeps them. */
function jsTag() {
  return { tag: 'tag:yaml.org,2002:js', resolve: value => value }
}

/** The watched document of the profile this integration launches. */
export function fabricProfilePatchPath(env = process.env, home = undefined) {
  const base = home ?? env.DSH_HOME?.trim() ?? ''

  if (!base) {
    throw new Error('fabricProfilePatchPath needs a harness home: pass one or set DSH_HOME')
  }

  return path.join(base, 'profiles', FABRIC_PROFILE_NAME, 'cordis.patch.yml')
}

/**
 * The profile patch path of the home the product resolves for this environment,
 * asked from the product's own resolver so a relocated harness home is not a
 * second rule to keep in sync.
 */
export async function resolveFabricProfilePatchPath(env = process.env) {
  const { resolveDshHome } = await loadWriteModules()

  return fabricProfilePatchPath(env, resolveDshHome(undefined, env))
}

/**
 * Find the effective `llm-pi-ai` entry of a parsed document: the last patch
 * with the id and no `insert`, since applyEntryPatches lets a later entry
 * override an earlier one in the same file.
 */
function findRouteEntry(doc, yaml) {
  const items = yaml.isSeq(doc.contents) ? doc.contents.items : []

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const row = items[index]

    if (yaml.isMap(row) && !row.has('insert') && doc.getIn([index, 'id']) === ROUTE_PLUGIN_ID) {
      return index
    }
  }

  return -1
}

/** The id list of a models node, in document order; anything else reads as none. */
function modelIdsOf(modelsNode, yaml) {
  if (!yaml.isSeq(modelsNode)) {
    return []
  }

  return modelsNode.items
    .map(item => (yaml.isMap(item) && typeof item.get('id') === 'string' ? item.get('id') : ''))
    .filter(Boolean)
}

/**
 * Read what the profile document currently serves for the fabric route.
 * @returns `null` when no route is configured yet, otherwise `{ baseURL, models,
 *   displayName, configurable }`. `configurable` is false only when the baseURL
 *   is a `!!js` expression — a deployment that computes its endpoint is managed
 *   by whoever wrote that expression, not by this module, and is reported so
 *   the watcher can leave it alone instead of fighting it. A route with no
 *   baseURL at all is an absence, not an expression, and stays adoptable.
 */
export function readFabricRoute(patchPath) {
  const yaml = loadYaml()
  let text

  try {
    text = fs.readFileSync(patchPath, 'utf8')
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      return null
    }

    throw new Error(`could not read ${patchPath}: ${cause.message}`)
  }

  const doc = yaml.parseDocument(text, { customTags: [jsTag()] })

  if (doc.errors.length > 0) {
    throw new Error(`${patchPath} does not parse as YAML: ${doc.errors[0].message}`)
  }

  const index = findRouteEntry(doc, yaml)

  if (index < 0) {
    return null
  }

  const providers = doc.getIn([index, 'config', 'providers'], true)
  const route = yaml.isMap(providers) ? providers.get(HOUDRY_ROUTE_KEY, true) : undefined

  if (!yaml.isMap(route)) {
    return null
  }

  const rawName = route.get('displayName')

  return {
    baseURL: readRouteBaseURL(route),
    models: modelIdsOf(route.get('models', true), yaml),
    displayName: typeof rawName === 'string' ? rawName : '',
    configurable: !isJsTagged(route.get('baseURL', true))
  }
}

function readRouteBaseURL(route) {
  const node = route.get('baseURL', true)

  if (node === undefined || isJsTagged(node) || typeof node.value !== 'string') {
    return ''
  }

  return node.value
}

function isJsTagged(node) {
  return node !== undefined && node.tag === 'tag:yaml.org,2002:js'
}

/** The provider entry a resolved plane serves. Capacities and compat switches are the overlay's, unchanged — the fabric's `/v1/models` still reports bare ids and its decoder still drops developer-role prompts. */
export function houdryProviderConfig({ url, models, displayName }) {
  return {
    displayName: displayName || HOUDRY_ROUTE_DEFAULTS.defaultDisplayName,
    api: HOUDRY_ROUTE_DEFAULTS.api,
    baseURL: url,
    apiKeyEnv: HOUDRY_ROUTE_DEFAULTS.apiKeyEnv,
    compat: {
      // The fabric decodes only system/user/assistant turns on its local
      // path, so a developer-role system prompt is dropped without an error.
      supportsDeveloperRole: false,
      // The fabric request struct names max_tokens only; an OpenAI
      // max_completion_tokens cap is ignored, leaving output uncapped.
      maxTokensField: 'max_tokens'
    },
    defaultContextWindow: HOUDRY_ROUTE_DEFAULTS.defaultContextWindow,
    defaultMaxTokens: HOUDRY_ROUTE_DEFAULTS.defaultMaxTokens,
    models: (models ?? []).map(id => ({ id }))
  }
}

/**
 * Rewrite the fabric route of the profile document, changing nothing else.
 * Sibling entries, sibling providers, and `!!js` expressions all round-trip
 * because the edit is made on the parsed document's own nodes. Writing what is
 * already there changes nothing, so a steady-state watcher loop does not touch
 * the file at all.
 *
 * The write takes the same lock the Models page's ConfigEditor takes
 * (`<profile>/package.json`), so a page save and a watcher adopt serialize
 * instead of racing, and the content lands through the product's atomic writer,
 * which is what lets the harness's file watcher never observe a torn document.
 * @returns `{ ok, changed, error, reason }` — `reason: 'parse'` marks a
 *   document this module refuses to touch (permanent), `'managed'` a route
 *   whose baseURL is a `!!js` expression (permanent — someone else's work),
 *   `'io'` a write the filesystem refused this once (retryable).
 */
export async function writeFabricRoute({ patchPath, url, models, displayName = '' } = {}) {
  const yaml = loadYaml()
  const { withFileLock, writeFileAtomic } = await loadWriteModules()

  let changed = false

  try {
    fs.mkdirSync(path.dirname(patchPath), { recursive: true, mode: 0o700 })
  } catch (cause) {
    return { ok: false, changed: false, error: `could not prepare ${path.dirname(patchPath)}: ${cause.message}`, reason: 'io' }
  }

  try {
    await withFileLock(path.join(path.dirname(patchPath), 'package.json'), async () => {
      let text

      try {
        text = fs.readFileSync(patchPath, 'utf8')
      } catch (cause) {
        if (cause.code !== 'ENOENT') {
          throw Object.assign(new Error(`could not read ${patchPath}: ${cause.message}`), { reason: 'io' })
        }

        text = '[]\n'
      }

      const doc = yaml.parseDocument(text, { customTags: [jsTag()] })

      if (doc.errors.length > 0) {
        throw Object.assign(new Error(`${patchPath} does not parse as YAML, so this module will not rewrite it: ${doc.errors[0].message}`), { reason: 'parse' })
      }

      if (!yaml.isSeq(doc.contents)) {
        throw Object.assign(new Error(`${patchPath} is not a YAML sequence of plugin entries, so this module will not rewrite it`), { reason: 'parse' })
      }

      doc.contents.flow = false

      const index = findRouteEntry(doc, yaml)

      if (index >= 0) {
        const providers = doc.getIn([index, 'config', 'providers'], true)
        const existing = yaml.isMap(providers) ? providers.get(HOUDRY_ROUTE_KEY, true) : undefined
        const existingBase = yaml.isMap(existing) ? existing.get('baseURL', true) : undefined

        if (isJsTagged(existingBase)) {
          throw Object.assign(new Error(`${patchPath} computes the houdry baseURL with a !!js expression, which this module does not overwrite`), { reason: 'managed' })
        }
      }

      const route = doc.createNode(houdryProviderConfig({ url, models, displayName }))

      if (index < 0) {
        doc.add(doc.createNode({ id: ROUTE_PLUGIN_ID, name: ROUTE_PLUGIN_NAME, config: { providers: { [HOUDRY_ROUTE_KEY]: route } } }))
      } else {
        const config = doc.getIn([index, 'config'], true)

        if (yaml.isMap(config)) {
          const providers = config.get('providers', true)

          if (yaml.isMap(providers)) {
            providers.set(HOUDRY_ROUTE_KEY, route)
          } else {
            config.set('providers', doc.createNode({ [HOUDRY_ROUTE_KEY]: route }))
          }
        } else {
          doc.setIn([index, 'config'], doc.createNode({ providers: { [HOUDRY_ROUTE_KEY]: route } }))
        }
      }

      // `!!js` values that reached the document as `{__jsExpr}` maps are
      // re-tagged on the way out, exactly as the page's own writer does.
      yaml.visit(doc, { Map(_key, node) {
        if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') {
          return
        }

        const expression = new yaml.Scalar(node.get('__jsExpr'))

        expression.tag = 'tag:yaml.org,2002:js'

        return expression
      } })

      const serialized = String(doc)

      if (serialized === text) {
        return
      }

      await writeFileAtomic(patchPath, serialized, { mode: 0o600 })

      changed = true
    }, { waitMs: DOCUMENT_LOCK_WAIT_MS })

    return { ok: true, changed, error: '', reason: '' }
  } catch (cause) {
    const reason = cause?.reason === 'parse' || cause?.reason === 'managed' || cause?.reason === 'io' ? cause.reason : 'io'

    return { ok: false, changed: false, error: cause?.message ?? String(cause), reason }
  }
}

/**
 * Whether a saved baseURL names a fabric plane this module may manage: https to
 * a private or loopback host. The Agent excluded Azure by slug; here the route
 * is the fabric's own, so anything a deployment repointed at a public host or
 * another scheme is by definition not this integration's to rewrite.
 */
export function isFabricRouteApi(raw) {
  try {
    const parsed = new URL(String(raw ?? '').trim())

    return parsed.protocol === 'https:' && isPrivateOrLoopback(parsed.hostname)
  } catch {
    return false
  }
}

/** True for 127.0.0.1 / localhost / ::1 — addresses this module never adopts or writes. */
export function isLoopbackRouteApi(raw) {
  try {
    // URL.hostname keeps IPv6 brackets.
    const host = new URL(String(raw ?? '').trim()).hostname.toLowerCase()
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

    return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1'
  } catch {
    return false
  }
}

/**
 * Same plane, spelled differently: the Agent compared origin plus path after
 * trimming trailing slashes; here `fabricApiOf` already normalizes the scheme
 * upgrade (`http://` advertisements), the default `/v1`, and trailing slashes,
 * so two spellings of one plane collapse to one api string.
 */
export function sameRouteApi(a, b) {
  const left = fabricApiOf(a)
  const right = fabricApiOf(b)

  return left !== null && right !== null && left.api === right.api
}

/** The picker's order is the configuration's order, so a reordered catalog is a change. */
export function routeModelsChanged(a, b) {
  return JSON.stringify(a ?? []) !== JSON.stringify(b ?? [])
}

/**
 * One reconnect decision, straight from the Agent's `decideFabricReconnect`:
 * the WiFi advertisement is the source of truth, a saved address from another
 * SSID must not win just because it still answers, and a loopback record is
 * never silently kept. `saved` is `readFabricRoute`'s reply (`null` before the
 * first launch); `discovered` is the preferred verified LAN plane this cycle,
 * with loopback advertisements already dropped by the scan.
 *
 * @returns `adopt` (rewrite address and models), `refresh` (same address, new
 *   catalog), `keep` (nothing to write), `retry` (nothing reliable yet), or
 *   `skip` (the route is not this module's to manage).
 */
export function decideRouteCycle({ saved, discovered, savedReachable = false } = {}) {
  // A `!!js` baseURL is someone else's expression and a public-host or non-https
  // address is not the fabric's; an absent baseURL is merely unfinished and
  // stays this module's to fill.
  if (saved !== null && (!saved.configurable || (saved.baseURL !== '' && !isFabricRouteApi(saved.baseURL)))) {
    return { action: 'skip' }
  }

  if (!discovered) {
    if (saved !== null && !isLoopbackRouteApi(saved.baseURL) && savedReachable) {
      return { action: 'keep', api: saved.baseURL, models: saved.models }
    }

    return { action: 'retry' }
  }

  // One write payload for both rows, so the name an operator gave the route
  // survives an address change exactly as it survives a catalog change.
  const write = { api: discovered.api, models: discovered.models, displayName: saved?.displayName || discovered.displayName || '' }

  if (saved === null || !sameRouteApi(saved.baseURL, write.api)) {
    return { action: 'adopt', ...write }
  }

  if (routeModelsChanged(saved.models, write.models)) {
    return { action: 'refresh', ...write }
  }

  return { action: 'keep', api: write.api, models: write.models }
}

/** The id list a resolver MODELS line carries, in the order it printed them. */
export function routeModelsFromList(list) {
  return String(list ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
}
