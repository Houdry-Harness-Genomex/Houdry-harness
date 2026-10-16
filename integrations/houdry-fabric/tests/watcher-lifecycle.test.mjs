// Lifecycle tests for the Houdry Fabric watcher integration in the web-app plugin.
//
// These tests verify that the watcher script accepts the correct arguments
// and environment variables when started by the web-app plugin.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const WATCHER_SCRIPT = fileURLToPath(new URL('../houdry-fabric-watch.mjs', import.meta.url))

/** A sandbox home for isolated testing. */
function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-lifecycle-home-'))

  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  return { home }
}

describe('houdry-fabric watcher lifecycle', () => {
  it('verifies the watcher script exists at the expected location', (t) => {
    assert.ok(fs.existsSync(WATCHER_SCRIPT), `watcher script must exist at ${WATCHER_SCRIPT}`)
  })

  it('accepts --parent argument without errors', async (t) => {
    const { home } = sandbox(t)
    const env = {
      ...process.env,
      DSH_HOME: home,
      HOUDRY_FABRIC_TOFU_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-lifecycle-tofu-')),
      HOUDRY_FABRIC_URL: '',
      HOUDRY_FABRIC_KEY: '',
      HOUDRY_FABRIC_CA: '',
    }

    t.after(() => {
      fs.rmSync(env.HOUDRY_FABRIC_TOFU_DIR, { recursive: true, force: true })
    })

    // Run watcher with --parent and --once (to exit immediately)
    const child = spawn(process.execPath, [WATCHER_SCRIPT, '--parent', String(process.pid), '--once'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })

    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', exitCode => resolve(exitCode))
    })

    // Watcher should exit cleanly with --once
    assert.equal(code, 0, `watcher with --parent and --once should exit cleanly, got code ${code}`)
  })

  it('accepts DSH_HOME environment variable', async (t) => {
    const { home } = sandbox(t)
    const tofu = fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-lifecycle-tofu-'))

    t.after(() => {
      fs.rmSync(tofu, { recursive: true, force: true })
    })

    const env = {
      ...process.env,
      DSH_HOME: home,
      HOUDRY_FABRIC_TOFU_DIR: tofu,
      HOUDRY_FABRIC_URL: '',
      HOUDRY_FABRIC_KEY: '',
      HOUDRY_FABRIC_CA: '',
    }

    // Run watcher with custom DSH_HOME
    const child = spawn(process.execPath, [WATCHER_SCRIPT, '--once'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''

    child.stderr.on('data', chunk => { stderr += chunk })

    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', exitCode => resolve(exitCode))
    })

    assert.equal(code, 0, `watcher should accept DSH_HOME and exit cleanly with --once, got code ${code}`)
  })

  it('rejects invalid --parent argument', async (t) => {
    const env = {
      ...process.env,
      DSH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-lifecycle-home-')),
      HOUDRY_FABRIC_TOFU_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-lifecycle-tofu-')),
      HOUDRY_FABRIC_URL: '',
      HOUDRY_FABRIC_KEY: '',
      HOUDRY_FABRIC_CA: '',
    }

    t.after(() => {
      fs.rmSync(env.DSH_HOME, { recursive: true, force: true })
      fs.rmSync(env.HOUDRY_FABRIC_TOFU_DIR, { recursive: true, force: true })
    })

    // Run watcher with invalid --parent (negative PID)
    const child = spawn(process.execPath, [WATCHER_SCRIPT, '--parent', '-1'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''

    child.stderr.on('data', chunk => { stderr += chunk })

    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', exitCode => resolve(exitCode))
    })

    // Should exit with error due to invalid --parent
    assert.notEqual(code, 0, 'watcher should reject invalid --parent argument')
    assert.ok(stderr.includes('--parent'), 'error message should mention --parent')
  })
})
