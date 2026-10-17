// The two files a fabric launch leaves behind: the token in the product's
// credential document, the plane it belongs to beside the pinned CAs.
//
// Harness already owns a credential store — `$DSH_HOME/.credentials.yaml`,
// written 0600 under a writer lock, read by the credentials service that
// `dsh`, `dsh web` and the desktop all resolve through. A launcher that stored
// its own copy of a plane token would put the same secret in a second file with
// a second set of rules, so this module keeps exactly one of each:
//
//   token   → `HOUDRY_FABRIC_KEY` in the credential document, rendered by the
//             product's own serializer (renderRef) under its writer lock
//   plane   → `fabric-connection.json` in the trust directory, which holds no
//             secret: an address, and a CA path the operator pointed at
//
// Both are reached by importing the built packages, so the parsing, the
// precedence and the locking stay in one implementation. Before `pnpm build`
// has produced `lib/`, the import fails and this degrades to environment-only —
// losing persistence, never losing a plane that was named on the command line.

import fs from 'node:fs'
import path from 'node:path'

import { fabricTofuDir, hasUsableSecret, PLACEHOLDER_FABRIC_KEY } from './houdry-connection.mjs'

/** The reference the houdry route's `apiKeyEnv` reads, so one stored value serves both. */
export const FABRIC_KEY_REF = 'HOUDRY_FABRIC_KEY'

/** Non-secret: which plane to reconnect to, and the CA file the operator chose. */
export const CONNECTION_FILENAME = 'fabric-connection.json'

// The provider waits this long for its writer lock; a launcher that gave up
// sooner would report failure over a lock another process was about to drop.
const DOCUMENT_LOCK_WAIT_MS = 30_000

const GROUP_OTHER_BITS = 0o077

// What a token-protected plane needs, and the one thing this resolver cannot
// produce for itself. It is asked for, never guessed: a token is not read off a
// process listing, a log, or the network, because a secret recovered that way is
// a secret that was never meant to leave the machine holding it.
const SETUP_GUIDE = [
  'this plane asks for a token and none was exported or stored. Hand it over once:',
  '  export HOUDRY_FABRIC_KEY=<token>, then start again — the launch that works stores it,',
  '  so the next one needs no environment at all, in the CLI, `dsh web` or the desktop app.',
  '  Or fill the key in on the Models page, which writes the same reference through the credentials service.',
  'The token is the value the plane was started with: `houdry serve --token <token>`.'
].join('\n')

// A plane that refused a token the operator did supply needs a different answer:
// which copy lost, and that the refused one was not kept.
const EXPORTED_REFUSED_GUIDE = [
  'the token exported as HOUDRY_FABRIC_KEY is not the one this plane was started with, and nothing was stored.',
  'Correct it, or store the right value through the credentials service; a launch that works replaces the stored copy.'
].join('\n')

const STORED_REFUSED_GUIDE = [
  'the token stored in the credential document is not the one this plane was started with, and it was left unchanged.',
  'Export HOUDRY_FABRIC_KEY with the current value to replace the stored copy, or write it through the credentials service.'
].join('\n')

/** Built once; a missing `lib/` is remembered, not retried on every launch. */
let productModules

async function loadProductModules() {
  if (productModules === undefined) {
    productModules = Promise.all([
      import('../../packages/credentials/credentials/lib/index.js'),
      import('../../packages/credentials/credentials-local/lib/index.js'),
      import('../../packages/util/atomic-write/lib/index.js'),
      import('../../packages/util/home-paths/lib/index.js')
    ]).then(([credentialRefModule, documentModule, atomicWriteModule, homePathsModule]) => ({
      credentialRef: credentialRefModule.credentialRef,
      parseCredentialsDocument: documentModule.parseCredentialsDocument,
      renderRef: documentModule.renderRef,
      resolveSpec: documentModule.resolveSpec,
      withFileLock: atomicWriteModule.withFileLock,
      writeFileAtomic: atomicWriteModule.writeFileAtomic,
      resolveDshHome: homePathsModule.resolveDshHome
    }))
  }

  return productModules
}

/**
 * Where the product keeps references for this home, asked from the provider's
 * own resolver so a relocated harness home is not a second rule to keep in sync.
 */
async function credentialDocumentOf(env) {
  const modules = await loadProductModules()
  const home = modules.resolveDshHome(undefined, env)

  return modules.resolveSpec({ dshHome: home }).filename
}

/**
 * The credential document as text, or `null` when there is nothing to read.
 * A file that exists but does not parse is reported through `onParseFailure`,
 * never swallowed: "no credentials stored" is the wrong conclusion to draw
 * from a document that cannot be trusted, and writing over it would destroy
 * credentials this tool cannot even name.
 */
function readCredentialRefs(filename, modules, onProblem) {
  let text

  try {
    text = fs.readFileSync(filename, 'utf8')
  } catch (cause) {
    if (cause.code !== 'ENOENT') {
      onProblem(`could not read ${filename}: ${cause.message}`)
    }

    return null
  }

  try {
    return [...modules.parseCredentialsDocument(text, filename).refs.entries()]
  } catch (cause) {
    // Diagnostics from this parser quote the key and the file, never a value.
    onProblem(cause.message)

    return null
  }
}

/**
 * Restore what an earlier launch saved. Values already in the environment win:
 * an operator who exports a token means it, and the saved copy only fills the
 * gaps that would otherwise need re-typing after a restart.
 * @param options - the launcher's environment and its stderr sink.
 * @returns the environment to connect with, plus the values that were restored.
 */
export async function savedFabricSettings({ env = process.env, note = () => {} } = {}) {
  const connection = readConnection(env)
  const settings = { url: connection.url, ca: connection.ca, key: '' }

  try {
    const filename = await credentialDocumentOf(env)
    const modules = await loadProductModules()
    const refs = readCredentialRefs(filename, modules, problem => note(`saved credentials are unreadable: ${problem}`))

    if (refs !== null) {
      settings.key = refs.find(([ref]) => ref === FABRIC_KEY_REF)?.[1] ?? ''
    }
  } catch (cause) {
    // No build, no store — persistence is unavailable, discovery is not.
    note(`the credential store is not available to this launcher (${cause.code ?? cause.message}); using the environment only`)
  }

  const merged = { ...env }

  for (const [name, field] of [['HOUDRY_FABRIC_URL', 'url'], ['HOUDRY_FABRIC_KEY', 'key'], ['HOUDRY_FABRIC_CA', 'ca']]) {
    if (!String(merged[name] ?? '').trim() && settings[field]) {
      merged[name] = settings[field]
    }
  }

  return { env: merged, ...settings }
}

/**
 * Which copy of the token the launch handed the plane, what to say if the plane
 * refused it, and what is worth storing if the plane accepted it.
 *
 * One decision feeding two calls, because both ask the same question: a token
 * read from the credential document is already stored, so saving it again would
 * rewrite the copy it just came from, and an operator told the token was refused
 * needs to know which of their two tokens lost. No text here carries the value,
 * or any part of it.
 * @param options - the token that was used, and the token the document holds.
 * @returns `source` ('', 'env', 'stored'), the guide to report, and the key to store.
 */
export function credentialUse({ usedKey = '', storedKey = '' } = {}) {
  const key = String(usedKey).trim()

  if (!key) {
    return { source: '', guide: SETUP_GUIDE, storableKey: '' }
  }

  if (key === String(storedKey).trim()) {
    return { source: 'stored', guide: STORED_REFUSED_GUIDE, storableKey: '' }
  }

  return { source: 'env', guide: EXPORTED_REFUSED_GUIDE, storableKey: key }
}

/**
 * Store what just worked, so the next launch reconnects without a re-export.
 * Only ever called after the plane authenticated the catalog probe.
 *
 * Two values are deliberately left out: the pinned CA file, because
 * `HOUDRY_FABRIC_CA` is trusted without re-checking it and storing a pin there
 * would silence the rotation warning the trust ladder exists to raise — a pin
 * already persists on its own in that same directory; and any placeholder, which
 * is what a keyless endpoint is told rather than a credential anyone owns.
 * @param options - the plane address, its CA override, the token that passed, the environment.
 * @returns whether each half landed, so a read-only home is reported and not fatal.
 */
export async function saveFabricSettings({ env = process.env, url = '', ca = '', key = '', note = () => {} } = {}) {
  const connection = writeConnection(env, { url, ca })

  if (!worthStoring(key)) {
    return { ...connection, tokenFile: '', tokenError: '' }
  }

  return { ...connection, ...(await writeCredentialRef(env, key, note)) }
}

/** A placeholder is what a keyless endpoint is told, not a credential to keep. */
function worthStoring(key) {
  return hasUsableSecret(key) && String(key).trim() !== PLACEHOLDER_FABRIC_KEY
}

/** @returns the saved plane address and CA path, empty when there is none. */
function readConnection(env) {
  const filename = path.join(fabricTofuDir(env), CONNECTION_FILENAME)
  let parsed = null

  try {
    parsed = JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch {
    // Absent, unreadable or truncated: a launch that has to reconnect by
    // discovery is the right answer for all three.
    return { url: '', ca: '' }
  }

  const text = value => (typeof value === 'string' ? value.trim() : '')

  return { url: text(parsed?.url), ca: text(parsed?.ca) }
}

/**
 * Replace the saved plane address. A launch that resolved the same one it
 * resolved last writes nothing, so the file keeps the time it was last changed
 * rather than the time it was last used.
 */
function writeConnection(env, { url, ca }) {
  const dir = fabricTofuDir(env)
  const filename = path.join(dir, CONNECTION_FILENAME)

  if (!url) {
    return { connectionFile: filename, connectionError: '' }
  }

  const next = `${JSON.stringify({ url, ...(ca ? { ca } : {}) }, null, 2)}\n`

  if (existsContent(filename, next)) {
    return { connectionFile: filename, connectionError: '' }
  }

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(filename, next, { encoding: 'utf8', mode: 0o600 })

    return { connectionFile: filename, connectionError: '' }
  } catch (cause) {
    return { connectionFile: filename, connectionError: `could not save the plane address at ${filename}: ${cause.message}` }
  }
}

/** Write `HOUDRY_FABRIC_KEY` through the product's serializer, lock included. */
async function writeCredentialRef(env, key, note) {
  let modules
  let filename

  try {
    modules = await loadProductModules()
    filename = await credentialDocumentOf(env)
  } catch (cause) {
    return { tokenFile: '', tokenError: `could not store the token: the credential store is unavailable (${cause.code ?? cause.message})` }
  }

  if (!ownerOnly(filename)) {
    // The product refuses to boot on such a file; storing a token into it would
    // hand the secret to whoever else can read it.
    return { tokenFile: filename, tokenError: `refused to store the token: ${filename} is readable beyond its owner; run "chmod 600 ${filename}"` }
  }

  try {
    await fs.promises.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    await modules.withFileLock(
      filename,
      async () => {
        // Read the lock's own view of the file: an entry another process added
        // while this lock was held has to be in the text that gets rendered.
        const text = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : undefined

        if (text !== undefined) {
          // Refuse to rewrite a document this build cannot read, as the provider
          // does — the failure it reports names the key, never a value.
          modules.parseCredentialsDocument(text, filename)
        }

        await modules.writeFileAtomic(filename, modules.renderRef(text, modules.credentialRef(FABRIC_KEY_REF), key.trim()), {
          mode: 0o600,
          dirMode: 0o700
        })
      },
      { waitMs: DOCUMENT_LOCK_WAIT_MS }
    )
  } catch (cause) {
    return { tokenFile: filename, tokenError: `could not store the token in ${filename}: ${cause.message}` }
  }

  note(`stored ${FABRIC_KEY_REF} in ${filename}; the next launch reads it without a re-export`)

  return { tokenFile: filename, tokenError: '' }
}

function existsContent(filename, content) {
  try {
    return fs.readFileSync(filename, 'utf8') === content
  } catch {
    return false
  }
}

function ownerOnly(filename) {
  if (process.platform === 'win32') {
    return true
  }

  try {
    return (fs.statSync(filename).mode & GROUP_OTHER_BITS) === 0
  } catch {
    return true
  }
}
