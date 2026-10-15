#!/usr/bin/env node
// Resolve a Houdry fabric control plane for the launcher, then print what dsh
// needs to start against it.
//
// The resolution is the Houdry Agent's, not a new design: plane (explicit URL →
// a plane remembered from the last launch that worked → LAN browse over UDP and
// mDNS → a plane already listening here), trust (insecure override →
// HOUDRY_FABRIC_CA → existing pin → the local houdry home root → trust on first
// use, refused for a public host), credential (explicit environment → the token
// stored in the credential document → a usable secret, or the placeholder a
// keyless endpoint still demands), and the catalog the plane actually serves
// right now.
//
// What authenticated is then stored, so the next launch reconnects without a
// re-export: the token in `$DSH_HOME/.credentials.yaml` through the same
// serializer the running product uses, the plane address beside the pinned CAs.
//
// stdout is machine-readable and tab-delimited so the launcher reads it
// literally — a value that came from anywhere on the LAN is never parsed by a
// shell. Diagnostics go to stderr. Exit 0 when a plane is usable, 2 when it is
// not: starting dsh against an unresolved trust decision is how a certificate
// problem turns into a confusing model error.
//
//   node resolve.mjs [--repin] [--no-save] [--timeout <ms>] [--no-mdns] [--json]

import process from 'node:process'

import { classifyLoopbackPort, connectFabric } from './houdry-connection.mjs'
import { credentialUse, saveFabricSettings, savedFabricSettings } from './fabric-credentials.mjs'
import { HOUDRY_PORTS } from './houdry-tls.mjs'
import { dshLaunchCommand } from './dsh-command.mjs'

const USAGE = [
  'usage: node resolve.mjs [--repin] [--no-save] [--timeout <ms>] [--no-mdns] [--json]',
  '',
  'Prints tab-delimited URL / CA / KEY / MODELS / NAME / ARG lines for the launcher.',
  'Reads HOUDRY_FABRIC_URL, HOUDRY_FABRIC_KEY, HOUDRY_FABRIC_CA, HOUDRY_FABRIC_INSECURE,',
  'HOUDRY_FABRIC_TOFU_DIR, HOUDRY_FABRIC_REPIN, HOUDRY_FABRIC_NO_SAVE and DSH_CMD.',
  '',
  'A plane that authenticated is stored so the next launch reconnects to it.',
  'The token goes to the credential document; it never appears in this output.',
  ''
].join('\n')

function parseArgs(argv) {
  const options = { repin: false, save: true, mdns: true, timeoutMs: 2_000, json: false, help: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--repin') {
      options.repin = true
    } else if (arg === '--no-save') {
      options.save = false
    } else if (arg === '--no-mdns') {
      options.mdns = false
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--timeout') {
      const value = Number(argv[i + 1])

      if (!(value > 0)) {
        throw new Error(`--timeout wants a positive number of milliseconds, got ${argv[i + 1] ?? '(nothing)'}`)
      }

      options.timeoutMs = value
      i += 1
    } else {
      throw new Error(`unknown argument ${arg} (try --help)`)
    }
  }

  return options
}

// A plane names itself over the wire, so a value that would break the
// line-per-field protocol is flattened rather than passed on to the launcher.
const field = (key, value) => `${key}\t${String(value ?? '').replace(/[\t\r\n]+/g, ' ')}\n`

/** Same coercion as HOUDRY_FABRIC_INSECURE: only these turn a flag on. */
const isOn = value => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())

async function reportUnreachable(options) {
  // A plane that is not discoverable is usually "nothing is serving it", but on
  // these ports something else is frequently answering, and that distinction is
  // the difference between starting the plane and opening a firewall.
  const squatters = await Promise.all(HOUDRY_PORTS.map(port => classifyLoopbackPort(port, { timeoutMs: options.timeoutMs })))

  squatters.forEach((status, index) => {
    if (status === 'busy') {
      process.stderr.write(`houdry: 127.0.0.1:${HOUDRY_PORTS[index]} answers HTTP but is not a Houdry control plane\n`)
    }
  })
}

let options

try {
  options = parseArgs(process.argv.slice(2))
} catch (cause) {
  process.stderr.write(`houdry: ${cause.message}\n`)
  process.exit(2)
}

if (options.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}

const note = message => process.stderr.write(`houdry: ${message}\n`)

// Restored values rank below the ones the operator exported for this run, so a
// throwaway token still means what it says, and above having to name the plane
// again after a restart.
const stored = await savedFabricSettings({ env: process.env, note })

const connect = env =>
  connectFabric({
    env,
    waitMs: options.timeoutMs,
    mdns: options.mdns,
    repin: options.repin || isOn(process.env.HOUDRY_FABRIC_REPIN),
    warn: note,
    note
  })

let connected = await connect(stored.env)

// Which copy of the token this launch handed the plane, named without printing it.
const used = credentialUse({ usedKey: stored.env.HOUDRY_FABRIC_KEY, storedKey: stored.key })
// Either way the plane answered; the difference is whether it was handed a token.
const refusedCredential = connected.code === 'auth' || connected.code === 'unauthorized'

// A saved address is a record of what answered last time, not a promise about
// this machine: a plane whose host moved off that IP must not strand the launch
// that discovery would have fixed. A refused credential is excluded — searching
// the network again finds the same plane and the same refusal.
if (!connected.ok && stored.url && !String(process.env.HOUDRY_FABRIC_URL ?? '').trim() && !refusedCredential) {
  note(`the saved plane ${stored.url} did not answer; searching for one again`)
  const { HOUDRY_FABRIC_URL, ...searchEnv } = stored.env
  connected = await connect(searchEnv)
}

if (!connected.ok) {
  process.stderr.write(`houdry: ${connected.error}\n`)

  if (connected.code === 'plane') {
    await reportUnreachable(options)
  }

  if (refusedCredential) {
    note(used.guide)
  }

  process.exit(2)
}

// The plane was given a credential to prove it by, so the catalog it served is
// the proof — and the only moment a token is worth keeping. A token that came
// from the credential document already is there, so it is not written again.
// The CA is read from the environment this launch connected with rather than the
// one it started in: an operator's CA path that this launch restored from disk
// has to be recorded again, or the launch that read it is the launch that lost it.
if (options.save) {
  const { connectionError, tokenError } = await saveFabricSettings({
    env: process.env,
    url: connected.api,
    ca: String(stored.env.HOUDRY_FABRIC_CA ?? '').trim(),
    key: used.storableKey,
    note
  })

  // A launch is not failed by a home that cannot be written: the plane answered,
  // and dsh still gets everything it needs from this run.
  for (const message of [connectionError, tokenError]) {
    if (message) {
      note(message)
    }
  }
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ ...connected, notes: undefined }, null, 2)}\n`)
  process.exit(0)
}

let out = field('URL', connected.api)

if (connected.caFile) {
  out += field('CA', connected.caFile)
}

// The placeholder only. A real token never leaves here in either direction: one
// the operator exported is already in the environment dsh inherits, and one read
// from the credential document is resolved again by dsh itself, through the
// credentials service. Copying either into this output would put a secret in a
// shell variable, a command trace, or a log.
if (connected.exportKey) {
  out += field('KEY', connected.exportKey)
}
out += field('MODELS', connected.models.join(','))

if (connected.plane.name) {
  out += field('NAME', connected.plane.name)
}

for (const token of dshLaunchCommand(process.env)) {
  out += field('ARG', token)
}

process.stdout.write(out)
process.exit(0)
