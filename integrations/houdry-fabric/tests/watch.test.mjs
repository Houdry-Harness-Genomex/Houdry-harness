// The session watcher: what it does to a home when a plane answers, when one
// stops, and when the document is not its business.
//
// The plane is a simulator on 127.0.0.1 — a real TLS server whose leaf is
// signed by the throwaway root in fixtures.mjs, speaking the three paths the
// engine probes. That makes the adopt path hermetic: the watcher TOFU-pins the
// simulator's root the way it would pin a LAN plane, but into a throwaway
// trust directory, and every write lands in a throwaway home. The cases with
// no network in them at all (routes this watcher must not manage, unparseable
// documents, argument and parent liveness) run the script as a subprocess with
// nothing to probe.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { fabricPinFile } from '../houdry-connection.mjs'
import { readFabricRoute } from '../houdry-fabric-patch.mjs'
import { SIMULATOR_LEAF, SIMULATOR_LEAF_KEY, SIMULATOR_ROOT } from './fixtures.mjs'

const WATCH = fileURLToPath(new URL('../houdry-fabric-watch.mjs', import.meta.url))

/** A harness home and trust directory belonging to no operator. */
function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-watch-home-'))
  const tofu = fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-watch-tofu-'))

  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(tofu, { recursive: true, force: true })
  })

  return {
    home,
    tofu,
    patchPath: path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
    env: { DSH_HOME: home, HOUDRY_FABRIC_TOFU_DIR: tofu, HOUDRY_FABRIC_URL: '', HOUDRY_FABRIC_KEY: '', HOUDRY_FABRIC_CA: '' }
  }
}

function writeDocument(box, text) {
  fs.mkdirSync(path.dirname(box.patchPath), { recursive: true })
  fs.writeFileSync(box.patchPath, text)

  return text
}

async function runWatcher(args, env) {
  const child = spawn(process.execPath, [WATCH, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''

  child.stdout.on('data', chunk => {
    stdout += chunk
  })

  child.stderr.on('data', chunk => {
    stderr += chunk
  })

  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', exitCode => resolve(exitCode))
  })

  return { code, stderr, stdout }
}

/** Bounded poll for a state the child owns; null means the deadline passed. */
async function waitFor(observe, deadlineMs) {
  const started = Date.now()

  for (;;) {
    const value = observe()

    if (value) {
      return value
    }

    if (Date.now() - started > deadlineMs) {
      return null
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** A control plane on loopback: identity document, pin endpoint, catalog. */
function startPlane({ models = ['m1', 'm2'], name = 'simulator-plane' } = {}) {
  const state = { models: [...models], name }

  const server = https.createServer({ key: SIMULATOR_LEAF_KEY, cert: SIMULATOR_LEAF }, (req, res) => {
    const respond = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type })
      res.end(body)
    }

    if (new URL(req.url, 'https://127.0.0.1').pathname === '/.well-known/houdry.json') {
      return respond(200, JSON.stringify({ houdry: 'control-plane', v: 1, name: state.name, auth: false }))
    }

    if (new URL(req.url, 'https://127.0.0.1').pathname === '/v1/pki/ca') {
      return respond(200, SIMULATOR_ROOT, 'application/x-pem-file')
    }

    if (new URL(req.url, 'https://127.0.0.1').pathname === '/v1/models') {
      return respond(200, JSON.stringify({ data: state.models.map(id => ({ id })) }))
    }

    return respond(404, JSON.stringify({ error: { code: 'not_found', message: req.url } }))
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, url: `https://127.0.0.1:${server.address().port}` })
    })
  })
}

/** Close the listener and every keep-alive socket the probes left open. */
async function stopPlane(plane) {
  plane.server.closeAllConnections?.()

  await new Promise(resolve => plane.server.close(resolve))
}

describe('the watcher against a plane on this machine', () => {
  it('adopts the pinned plane and records the route, the pin, and the address', async (t) => {
    const box = sandbox(t)
    const plane = await startPlane({ models: ['m1', 'm2'], name: 'simulator-plane' })

    t.after(() => stopPlane(plane))

    const out = await runWatcher(['--once'], { ...box.env, HOUDRY_FABRIC_URL: plane.url })

    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stderr, /now serving /)

    assert.deepEqual(readFabricRoute(box.patchPath), {
      baseURL: `${plane.url}/v1`,
      models: ['m1', 'm2'],
      displayName: 'Houdry Fabric',
      caFile: fabricPinFile(box.tofu, plane.url),
      configurable: true
    })

    assert.equal(fs.readdirSync(path.join(box.tofu, 'cas')).length, 1)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(box.tofu, 'fabric-connection.json'), 'utf8')), { url: `${plane.url}/v1` })
  })

  it('names the address it replaces and keeps the name the operator gave the route', async (t) => {
    const box = sandbox(t)
    const recorded = await startPlane({ models: ['m1'], name: 'plane-one' })
    const adopted = await startPlane({ models: ['m2'], name: 'plane-two' })

    t.after(() => stopPlane(recorded))
    t.after(() => stopPlane(adopted))

    // The document already carries a plane and a name chosen by hand, so this
    // cycle replaces one address with another rather than filling in a gap.
    writeDocument(box, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      houdry:',
      '        displayName: Studio GPU',
      `        baseURL: ${recorded.url}/v1`,
      '        apiKeyEnv: HOUDRY_FABRIC_KEY',
      '        models:',
      '          - id: m1',
      ''
    ].join('\n'))

    const out = await runWatcher(['--once'], { ...box.env, HOUDRY_FABRIC_URL: adopted.url })

    assert.equal(out.code, 0, out.stderr)
    assert.ok(out.stderr.includes(`replaced the route at ${recorded.url}/v1`), out.stderr)

    assert.deepEqual(readFabricRoute(box.patchPath), {
      baseURL: `${adopted.url}/v1`,
      models: ['m2'],
      displayName: 'Studio GPU',
      caFile: fabricPinFile(box.tofu, adopted.url),
      configurable: true
    })
  })

  it('refreshes the catalog when the plane changes it', async (t) => {
    const box = sandbox(t)
    const plane = await startPlane({ models: ['m1'] })

    t.after(() => stopPlane(plane))

    const env = { ...box.env, HOUDRY_FABRIC_URL: plane.url }

    const first = await runWatcher(['--once'], env)

    assert.equal(first.code, 0, first.stderr)
    assert.deepEqual(readFabricRoute(box.patchPath).models, ['m1'])

    plane.state.models = ['m1', 'm3']

    const second = await runWatcher(['--once'], env)

    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stderr, /now serves: m1, m3/)
    assert.deepEqual(readFabricRoute(box.patchPath).models, ['m1', 'm3'])
  })

  it('keeps writing nothing when the pinned plane is not answering', async (t) => {
    const box = sandbox(t)
    const plane = await startPlane()
    const url = plane.url

    await stopPlane(plane)

    const out = await runWatcher(['--once'], { ...box.env, HOUDRY_FABRIC_URL: url })

    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stderr, /is not answering/)
    assert.equal(readFabricRoute(box.patchPath), null)
  })
})

describe('the watcher with nothing to probe', () => {
  it('stops for a route a !!js expression manages', async (t) => {
    const box = sandbox(t)
    writeDocument(box, '- id: llm-pi-ai\n  config:\n    providers:\n      houdry:\n        baseURL: !!js process.env.MY_PLANE_URL\n        models: []\n')

    const out = await runWatcher(['--once'], box.env)

    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stderr, /not this watcher's to manage/)
    assert.match(out.stderr, /!!js/)
  })

  it('stops for a route that does not name a fabric plane', async (t) => {
    const box = sandbox(t)
    writeDocument(box, '- id: llm-pi-ai\n  config:\n    providers:\n      houdry:\n        baseURL: https://fabric.example.com:18080/v1\n        models: []\n')

    const out = await runWatcher(['--once'], box.env)

    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stderr, /not this watcher's to manage/)
    assert.match(out.stderr, /does not name a Houdry fabric plane/)
  })

  it('waits for a document that does not parse', async (t) => {
    const box = sandbox(t)
    writeDocument(box, '- id: llm-pi-ai\n  config: [broken\n')

    const out = await runWatcher(['--once'], box.env)

    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stderr, /does not parse as YAML/)
    assert.match(out.stderr, /waiting for the document to be fixed/)
  })

  it('refuses arguments it cannot read', async (t) => {
    const box = sandbox(t)

    const out = await runWatcher(['--bogus'], box.env)

    assert.equal(out.code, 2)
    assert.match(out.stderr, /unknown argument --bogus/)
  })

  it('stops when the launcher that started it is gone', async (t) => {
    const box = sandbox(t)
    const keeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })

    t.after(() => keeper.kill())

    keeper.kill()

    const dead = await waitFor(() => {
      try {
        process.kill(keeper.pid, 0)

        return false
      } catch (cause) {
        return cause.code === 'ESRCH'
      }
    }, 10_000)

    assert.ok(dead, 'the keeper process should be gone before the watcher starts')

    const out = await runWatcher(['--once', '--parent', String(keeper.pid)], box.env)

    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stderr, /the launcher \(pid \d+\) is gone; stopping/)
  })
})

describe('one watcher per home', () => {
  it('a second watcher defers to the first, and the first leaves with its parent', async (t) => {
    const box = sandbox(t)
    // Pinned to an address nothing answers keeps the first watcher alive
    // without discovering whatever else shares the machine or the network.
    const env = { ...box.env, HOUDRY_FABRIC_URL: 'https://10.255.254.253:18081' }
    const keeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
    const first = spawn(process.execPath, [WATCH, '--parent', String(keeper.pid), '--no-mdns', '--timeout', '250'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let diagnostics = ''

    first.stderr?.on('data', chunk => {
      diagnostics += chunk
    })

    t.after(() => {
      keeper.kill()
      first.kill()
    })

    const pidfile = path.join(box.tofu, 'fabric-watch.pid')
    const claimed = await waitFor(() => {
      try {
        return fs.readFileSync(pidfile, 'utf8').trim() === String(first.pid)
      } catch {
        return false
      }
    }, 10_000)

    assert.ok(claimed, `the first watcher should claim the pidfile; it said: ${diagnostics}`)

    const second = await runWatcher(['--no-mdns', '--timeout', '250'], env)

    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stderr, /a fabric watcher is already running/)

    keeper.kill()

    const exited = await waitFor(() => first.exitCode !== null, 30_000)

    assert.ok(exited, `the first watcher should follow its parent out; it said: ${diagnostics}`)
    assert.equal(first.exitCode, 0)
    assert.equal(fs.existsSync(pidfile), false)
  })
})
