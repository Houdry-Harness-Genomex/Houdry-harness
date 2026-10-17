// The launcher's own contract: how DSH_CMD becomes argv in a way both start.sh
// and start.ps1 can share, and how resolve.mjs behaves when it is handed a
// command line it cannot use.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { dshLaunchCommand, tokenizeCommand } from '../dsh-command.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const resolve = path.join(here, '..', 'resolve.mjs')

function run(args, env = {}) {
  return spawnSync(process.execPath, [resolve, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000
  })
}

describe('tokenizeCommand', () => {
  it('splits on whitespace and keeps a quoted path in one piece', () => {
    assert.deepEqual(tokenizeCommand('dsh'), ['dsh'])
    assert.deepEqual(tokenizeCommand('pnpm dsh'), ['pnpm', 'dsh'])
    assert.deepEqual(tokenizeCommand('  node   "C:\\Program Files\\dsh\\dsh.mjs"  '), ['node', 'C:\\Program Files\\dsh\\dsh.mjs'])
    assert.deepEqual(tokenizeCommand("node '/opt/my tools/dsh' --profile web"), ['node', '/opt/my tools/dsh', '--profile', 'web'])
  })

  it('escapes inside double quotes and treats single quotes as literal', () => {
    assert.deepEqual(tokenizeCommand('node "a \\"quoted\\" mjs"'), ['node', 'a "quoted" mjs'])
    assert.deepEqual(tokenizeCommand('node "back\\\\slash"'), ['node', 'back\\slash'])
    assert.deepEqual(tokenizeCommand(`node 'no $escapes \\here'`), ['node', 'no $escapes \\here'])
    assert.deepEqual(tokenizeCommand('node a\\ b'), ['node', 'a b'])
  })

  it('refuses a half-parsed command instead of launching something else', () => {
    assert.throws(() => tokenizeCommand('node "dsh.mjs'), /unterminated double quote/)
    assert.throws(() => tokenizeCommand("node 'dsh.mjs"), /unterminated single quote/)
    assert.throws(() => tokenizeCommand('node dsh\\'), /trailing backslash/)
    assert.deepEqual(tokenizeCommand(''), [])
    assert.deepEqual(tokenizeCommand(undefined), [])
  })
})

describe('dshLaunchCommand', () => {
  it('defaults to dsh and follows DSH_CMD when it is set', () => {
    assert.deepEqual(dshLaunchCommand({}), ['dsh'])
    assert.deepEqual(dshLaunchCommand({ DSH_CMD: '  ' }), ['dsh'])
    assert.deepEqual(dshLaunchCommand({ DSH_CMD: 'pnpm dsh' }), ['pnpm', 'dsh'])
    assert.deepEqual(dshLaunchCommand({ DSH_CMD: 'node "C:\\Program Files\\dsh\\cli.js" --profile web' }), [
      'node',
      'C:\\Program Files\\dsh\\cli.js',
      '--profile',
      'web'
    ])
  })
})

describe('resolve.mjs', () => {
  it('prints its usage and exits clean', () => {
    const out = run(['--help'])

    assert.equal(out.status, 0)
    assert.match(out.stdout, /^usage: node resolve\.mjs/)
    assert.match(out.stdout, /DSH_CMD/)
  })

  it('rejects a bad command line without a stack trace', () => {
    const unknown = run(['--bogus'])

    assert.equal(unknown.status, 2)
    assert.match(unknown.stderr, /houdry: unknown argument --bogus/)
    assert.doesNotMatch(unknown.stderr, /at .*node:internal/)

    const timeout = run(['--timeout'])

    assert.equal(timeout.status, 2)
    assert.match(timeout.stderr, /--timeout wants a positive number/)
  })
})
