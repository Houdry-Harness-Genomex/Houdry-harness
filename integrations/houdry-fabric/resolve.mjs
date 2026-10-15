#!/usr/bin/env node
// Resolve a Houdry fabric control plane for the launcher, then print what dsh
// needs to start against it.
//
// The resolution is the Houdry Agent's, not a new design: plane (explicit URL →
// LAN browse over UDP and mDNS → a plane already listening here), trust
// (insecure override → HOUDRY_FABRIC_CA → existing pin → the local houdry home
// root → trust on first use, refused for a public host), credential (a usable
// secret, or the placeholder a keyless endpoint still demands), and the catalog
// the plane actually serves right now.
//
// stdout is machine-readable and tab-delimited so the launcher reads it
// literally — a value that came from anywhere on the LAN is never parsed by a
// shell. Diagnostics go to stderr. Exit 0 when a plane is usable, 2 when it is
// not: starting dsh against an unresolved trust decision is how a certificate
// problem turns into a confusing model error.
//
//   node resolve.mjs [--repin] [--timeout <ms>] [--no-mdns] [--json]

import process from 'node:process'

import { classifyLoopbackPort, connectFabric } from './houdry-connection.mjs'
import { HOUDRY_PORTS } from './houdry-tls.mjs'
import { dshLaunchCommand } from './dsh-command.mjs'

const USAGE = [
  'usage: node resolve.mjs [--repin] [--timeout <ms>] [--no-mdns] [--json]',
  '',
  'Prints tab-delimited URL / CA / KEY / MODELS / NAME / ARG lines for the launcher.',
  'Reads HOUDRY_FABRIC_URL, HOUDRY_FABRIC_KEY, HOUDRY_FABRIC_CA, HOUDRY_FABRIC_INSECURE,',
  'HOUDRY_FABRIC_TOFU_DIR, HOUDRY_FABRIC_REPIN and DSH_CMD.',
  ''
].join('\n')

function parseArgs(argv) {
  const options = { repin: false, mdns: true, timeoutMs: 2_000, json: false, help: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--repin') {
      options.repin = true
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

const connected = await connectFabric({
  env: process.env,
  waitMs: options.timeoutMs,
  mdns: options.mdns,
  repin: options.repin || isOn(process.env.HOUDRY_FABRIC_REPIN),
  warn: note,
  note
})

if (!connected.ok) {
  process.stderr.write(`houdry: ${connected.error}\n`)

  if (connected.code === 'plane') {
    await reportUnreachable(options)
  }

  process.exit(2)
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ ...connected, notes: undefined }, null, 2)}\n`)
  process.exit(0)
}

let out = field('URL', connected.api)

if (connected.caFile) {
  out += field('CA', connected.caFile)
}

// The placeholder only: a token the operator exported stays in their environment
// and is never copied back out through a launcher.
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
