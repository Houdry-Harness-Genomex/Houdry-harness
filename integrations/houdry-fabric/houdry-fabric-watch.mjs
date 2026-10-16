#!/usr/bin/env node
// The session watcher: the Houdry Agent's always-on reconnect loop, running
// beside dsh instead of inside it.
//
// The Agent held its endpoint in application state and re-resolved it as the
// machine moved; here that state is the profile's patch document, and the loop
// around it is this process. Every tick it asks whether the plane the route
// names still answers and what it now serves — connectFabric is the same
// resolve, trust, credential and catalog engine the boot resolver runs — and
// lets decideRouteCycle choose between rewriting the route (a new plane on
// this network, a changed catalog) and leaving it alone. The write is the
// point: the running server watches that document, re-reads it, and the model
// picker updates without a restart.
//
// This process owns no foreground and no credential. Tokens are stored by the
// boot resolve that watched a plane authenticate; the only writes here are the
// route and the plain-text plane address beside the pins. stdout stays empty —
// everything this watcher has to say goes to stderr, prefixed houdry-watch.
//
//   node houdry-fabric-watch.mjs [--parent <pid>] [--once] [--no-mdns]
//                                [--timeout <ms>]

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { connectFabric, fabricTofuDir } from './houdry-connection.mjs'
import { savedFabricSettings, saveFabricSettings } from './fabric-credentials.mjs'
import {
  decideRouteCycle,
  isFabricRouteApi,
  readFabricRoute,
  resolveFabricProfilePatchPath,
  sameRouteApi,
  writeFabricRoute
} from './houdry-fabric-patch.mjs'

/** The Agent's reconnect cadences: eager while searching, unhurried while served. */
const RESCAN_MS = 2_500
const CONNECTED_RECHECK_MS = 15_000

/** Quiet scans between "still nothing" lines, so a laptop on the wrong WiFi is not spammed. */
const MAX_EMPTY_SCANS = 20

const PIDFILE_NAME = 'fabric-watch.pid'

const USAGE = [
  'usage: node houdry-fabric-watch.mjs [--parent <pid>] [--once] [--no-mdns] [--timeout <ms>]',
  '',
  'Keeps the profile patch document pointed at a Houdry fabric control plane:',
  'a plane that moves networks is followed, a catalog that changes is refreshed,',
  'and a plane the operator pinned with HOUDRY_FABRIC_URL is served but never',
  'replaced. Reads HOUDRY_FABRIC_URL, HOUDRY_FABRIC_KEY, HOUDRY_FABRIC_CA and',
  'HOUDRY_FABRIC_INSECURE, and what earlier launches stored.'
].join('\n')

function parseArgs(argv) {
  const options = { parent: 0, once: false, mdns: true, timeoutMs: 2_000, help: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--once') {
      options.once = true
    } else if (arg === '--no-mdns') {
      options.mdns = false
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--timeout') {
      const value = Number(argv[i + 1])

      if (!(value > 0)) {
        throw new Error(`--timeout wants a positive number of milliseconds, got ${argv[i + 1] ?? '(nothing)'}`)
      }

      options.timeoutMs = value
      i += 1
    } else if (arg === '--parent') {
      const value = Number(argv[i + 1])

      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--parent wants a process id, got ${argv[i + 1] ?? '(nothing)'}`)
      }

      options.parent = value
      i += 1
    } else {
      throw new Error(`unknown argument ${arg} (try --help)`)
    }
  }

  return options
}

const note = message => process.stderr.write(`houdry-watch: ${message}\n`)

/** EPERM means "alive but not ours to signal", which is still alive. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)

    return true
  } catch (cause) {
    return cause.code === 'EPERM'
  }
}

function readPidfile(filename) {
  try {
    const pid = Number(fs.readFileSync(filename, 'utf8').trim())

    return Number.isInteger(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

function claimPidfile(filename) {
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  } catch (cause) {
    // A trust directory that cannot hold a pidfile still holds pins; a second
    // watcher writing the same document behind a file lock is slow, not wrong.
    note(`could not prepare the watcher pid directory at ${filename}: ${cause.message}`)

    return { claimed: true, existing: 0 }
  }

  for (;;) {
    try {
      const descriptor = fs.openSync(filename, 'wx', 0o600)

      fs.writeFileSync(descriptor, `${process.pid}\n`)
      fs.closeSync(descriptor)

      return { claimed: true, existing: 0 }
    } catch (cause) {
      if (cause.code !== 'EEXIST') {
        note(`could not record the watcher pid at ${filename}: ${cause.message}`)

        return { claimed: true, existing: 0 }
      }
    }

    const existing = readPidfile(filename)

    if (existing !== 0 && existing !== process.pid && pidAlive(existing)) {
      return { claimed: false, existing }
    }

    try {
      fs.rmSync(filename, { force: true })
    } catch (cause) {
      note(`could not clear stale watcher pid at ${filename}: ${cause.message}`)

      return { claimed: false, existing: 0 }
    }
  }
}

let options

try {
  options = parseArgs(process.argv.slice(2))
} catch (cause) {
  note(cause.message)
  process.exit(2)
}

if (options.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let running = true
let pidfile = ''

function releasePidfile() {
  if (!pidfile || readPidfile(pidfile) !== process.pid) {
    return
  }

  try {
    fs.rmSync(pidfile, { force: true })
  } catch {
    // A pidfile left behind by a hard kill is stale, and stale is handled.
  }
}

process.on('exit', releasePidfile)

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    running = false
    releasePidfile()
    process.exit(0)
  })
}

let patchPath

try {
  patchPath = await resolveFabricProfilePatchPath(process.env)
} catch (cause) {
  note(`${cause.message}`)
  process.exit(2)
}

if (!options.once) {
  pidfile = path.join(fabricTofuDir(process.env), PIDFILE_NAME)
  const claim = claimPidfile(pidfile)

  if (!claim.claimed) {
    note(`a fabric watcher is already running (pid ${claim.existing}); this launch is covered`)
    process.exit(0)
  }
}

// What the operator exported for this run outranks every saved record, and it
// changes what the watcher is for: a pinned plane is served and refreshed but
// never replaced by whatever else the network advertises.
const pinned = String(process.env.HOUDRY_FABRIC_URL ?? process.env.HOUDRY_BASE_URL ?? '').trim()

const base = await savedFabricSettings({ env: process.env, note })
const savedCa = String(base.env.HOUDRY_FABRIC_CA ?? '').trim()

const probeEnv = url => ({ ...base.env, HOUDRY_FABRIC_URL: url, HOUDRY_BASE_URL: '' })
const searchEnv = { ...base.env, HOUDRY_FABRIC_URL: '', HOUDRY_BASE_URL: '' }

const connect = env =>
  connectFabric({ env, waitMs: options.timeoutMs, mdns: options.mdns, repin: false, warn: () => {}, note: () => {} })

// Diagnostics the engine raises on the way (first-use pins, trust warnings)
// are worth one line each, not one line per cycle.
const seenNotes = new Set()

const report = notes => {
  for (const message of notes ?? []) {
    if (!seenNotes.has(message)) {
      seenNotes.add(message)
      note(message)
    }
  }
}

let emptyScans = 0
let lastParseError = ''
let lastFailure = ''
let failureRepeats = 0

function noteFailure(result) {
  const text = [result?.plane?.api ?? '', result?.error ?? ''].filter(Boolean).join(': ')

  if (!text) {
    return
  }

  if (text !== lastFailure) {
    lastFailure = text
    failureRepeats = 1
    note(text)

    return
  }

  failureRepeats += 1

  if (failureRepeats % MAX_EMPTY_SCANS === 0) {
    note(`${text} (repeated ${failureRepeats} times)`)
  }
}

/**
 * One reconnect decision, executed: read the route, ask the network one
 * question (the plane the route names, or the pinned one, or the whole
 * network), and let the decision table pick between writing and waiting.
 * @returns whether a plane answered, which sets how long the next sleep is.
 */
async function tick() {
  if (options.parent && !pidAlive(options.parent)) {
    note(`the launcher (pid ${options.parent}) is gone; stopping`)
    running = false

    return { connected: false }
  }

  let saved

  try {
    saved = readFabricRoute(patchPath)
  } catch (cause) {
    if (cause.message !== lastParseError) {
      lastParseError = cause.message
      note(`${cause.message}; waiting for the document to be fixed`)
    }

    return { connected: false }
  }

  lastParseError = ''

  // A route someone else manages is not asked about on the network at all —
  // the same skip the decision table would return, checked before any probe.
  if (saved !== null && !saved.configurable) {
    note(`the houdry route in ${patchPath} computes its baseURL with a !!js expression and is not this watcher's to manage; stopping`)
    running = false

    return { connected: false }
  }

  if (saved !== null && saved.baseURL !== '' && !isFabricRouteApi(saved.baseURL)) {
    note(`the houdry route in ${patchPath} does not name a Houdry fabric plane and is not this watcher's to manage; stopping`)
    running = false

    return { connected: false }
  }

  // The route names a plane; a pin fills it in only when the boot write could
  // not (the document did not exist yet). Either way one origin is asked per
  // tick, and only when it does not answer does the network get scanned.
  const target = pinned || saved?.baseURL || ''

  let answered = null
  let discovered = null

  if (target) {
    answered = await connect(probeEnv(target))
    report(answered.notes)
  }

  if (!answered?.ok && !pinned) {
    discovered = await connect(searchEnv)
    report(discovered.notes)
  }

  const result = answered?.ok ? answered : discovered?.ok ? discovered : null

  if (!result) {
    noteFailure(answered)
    noteFailure(discovered)

    emptyScans += 1

    if (pinned) {
      if (emptyScans === 1 || emptyScans % MAX_EMPTY_SCANS === 0) {
        note(`${pinned} is not answering (checked ${emptyScans} time${emptyScans === 1 ? '' : 's'})`)
      }
    } else if (emptyScans === 1) {
      note('searching for a Houdry control plane on this network')
    } else if (emptyScans % MAX_EMPTY_SCANS === 0) {
      note(`still no Houdry control plane on this network (${emptyScans} scans)`)
    }

    return { connected: false }
  }

  emptyScans = 0
  lastFailure = ''
  failureRepeats = 0

  const discovered_ = { api: result.api, models: result.models, displayName: result.plane?.name ?? '' }
  const decision = decideRouteCycle({ saved, discovered: discovered_, savedReachable: answered?.ok === true })

  if (decision.action === 'skip') {
    note(
      saved?.configurable === false
        ? `the houdry route in ${patchPath} computes its baseURL with a !!js expression and is not this watcher's to manage; stopping`
        : `the houdry route in ${patchPath} does not name a Houdry fabric plane and is not this watcher's to manage; stopping`
    )
    running = false

    return { connected: false }
  }

  if (decision.action === 'adopt') {
    const previous = saved?.baseURL ?? ''
    const write = await writeFabricRoute({ patchPath, url: decision.api, models: decision.models, displayName: decision.displayName })

    if (!write.ok) {
      // The plane answers; the document is the problem, and the next tick tries again.
      note(`could not record the plane: ${write.error}`)

      return { connected: true }
    }

    if (write.changed) {
      const moved = previous !== '' && !sameRouteApi(previous, decision.api)
      // Worth naming which address stops being the live one: a route the operator
      // had pointed somewhere is replaced by this write, and whether it still
      // answered is only reportable when this cycle actually asked it.
      const asked = moved && sameRouteApi(previous, target) && answered?.ok !== true

      note(
        `now serving ${decision.api}` +
          (decision.displayName ? ` as "${decision.displayName}"` : '') +
          (moved ? ` — replaced the route at ${previous}${asked ? ', which did not answer this cycle' : ''}` : '') +
          (moved ? ' — chat turns keep the certificate this dsh started with until it is restarted' : '')
      )

      const savedSettings = await saveFabricSettings({ env: process.env, url: decision.api, ca: savedCa, key: '' })

      if (savedSettings.connectionError) {
        note(savedSettings.connectionError)
      }
    }

    return { connected: true }
  }

  if (decision.action === 'refresh') {
    // Same plane, new catalog: the address and whatever the operator renamed
    // the route to are left exactly as the document has them.
    const write = await writeFabricRoute({ patchPath, url: decision.api, models: decision.models, displayName: saved?.displayName ?? '' })

    if (!write.ok) {
      note(`could not refresh the catalog: ${write.error}`)

      return { connected: true }
    }

    if (write.changed) {
      note(`the catalog at ${decision.api} now serves: ${decision.models.join(', ')}`)
    }

    return { connected: true }
  }

  // keep: the document already says the right thing. retry: nothing reliable
  // was learned this tick.
  return { connected: decision.action === 'keep' }
}

note(pinned ? `an operator pinned ${pinned}; this watcher serves that plane and adopts no other` : 'watching for a Houdry fabric control plane')
note(`the live route is ${patchPath}`)

while (running) {
  const outcome = await tick()

  if (options.once || !running) {
    break
  }

  await sleep(outcome.connected ? CONNECTED_RECHECK_MS : RESCAN_MS)
}
