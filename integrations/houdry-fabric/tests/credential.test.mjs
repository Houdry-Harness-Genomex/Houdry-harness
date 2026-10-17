// Credential persistence for the fabric launcher: what a launch restores, what
// it stores, and what it must never write down.
//
// The store under test is the product's own — `$DSH_HOME/.credentials.yaml`,
// read and rendered by `credentials-local` — so the assertions are made with
// that package's parser rather than a second one. Each case runs against a
// throwaway harness home: nothing here may touch the operator's real document.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { parseCredentialsDocument } from '../../../packages/credentials/credentials-local/lib/index.js'
import { CONNECTION_FILENAME, FABRIC_KEY_REF, credentialUse, saveFabricSettings, savedFabricSettings } from '../fabric-credentials.mjs'
import { PLACEHOLDER_FABRIC_KEY } from '../houdry-connection.mjs'

const STORED_TOKEN = 'aabbccddeeff0011'
const EXPORTED_TOKEN = '1122334455667700'
const PLANE = 'https://192.168.1.20:18080/v1'

/**
 * A harness home and a trust directory that belong to no operator. Nothing from
 * the surrounding environment is inherited: an exported fabric variable on the
 * test machine would otherwise decide what these cases see.
 */
function sandbox(t, over = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-cred-'))
  const tofu = fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-tofu-'))

  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(tofu, { recursive: true, force: true })
  })

  return {
    home,
    tofu,
    document: path.join(home, '.credentials.yaml'),
    connection: path.join(tofu, CONNECTION_FILENAME),
    env: { DSH_HOME: home, HOUDRY_FABRIC_TOFU_DIR: tofu, HOUDRY_FABRIC_URL: '', HOUDRY_FABRIC_KEY: '', HOUDRY_FABRIC_CA: '', ...over }
  }
}

/** Every diagnostic about a credential is a promise not to print one, so they are all collected. */
function collector() {
  const notes = []

  return { notes, note: message => notes.push(String(message)) }
}

function writeDocument(box, text) {
  fs.mkdirSync(box.home, { recursive: true })
  fs.writeFileSync(box.document, text)

  return text
}

function refsOf(filename) {
  return [...parseCredentialsDocument(fs.readFileSync(filename, 'utf8'), filename).refs.entries()]
}

describe('fabric credential persistence', () => {
  describe('restoring what the last launch saved', () => {
    it('fills an unset environment from the stored token and plane', async (t) => {
      const box = sandbox(t)
      const report = collector()

      await saveFabricSettings({ env: box.env, url: PLANE, key: STORED_TOKEN, note: report.note })

      const restored = await savedFabricSettings({ env: box.env, note: report.note })

      assert.equal(restored.env.HOUDRY_FABRIC_URL, PLANE)
      assert.equal(restored.env.HOUDRY_FABRIC_KEY, STORED_TOKEN)
      assert.equal(restored.url, PLANE)
      assert.equal(restored.key, STORED_TOKEN)
      assert.deepEqual(refsOf(box.document), [[FABRIC_KEY_REF, STORED_TOKEN]])
      assert.equal(report.notes.join('\n').includes(STORED_TOKEN), false)
    })

    it('lets a value exported for this run outrank the stored one', async (t) => {
      const exportedPlane = 'https://192.168.1.99:18080/v1'
      const box = sandbox(t, { HOUDRY_FABRIC_KEY: EXPORTED_TOKEN, HOUDRY_FABRIC_URL: exportedPlane })
      const report = collector()

      await saveFabricSettings({ env: box.env, url: PLANE, key: STORED_TOKEN, note: report.note })

      const restored = await savedFabricSettings({ env: box.env, note: report.note })

      assert.equal(restored.env.HOUDRY_FABRIC_KEY, EXPORTED_TOKEN)
      assert.equal(restored.env.HOUDRY_FABRIC_URL, exportedPlane)
      // What is stored is still reported: it is how the launcher knows this run
      // authenticated with a different token, and so has a store to update.
      assert.equal(restored.key, STORED_TOKEN)
      assert.deepEqual(refsOf(box.document), [[FABRIC_KEY_REF, STORED_TOKEN]])
    })

    it('treats a blank exported value as no export at all', async (t) => {
      const box = sandbox(t)
      const report = collector()

      await saveFabricSettings({ env: box.env, url: PLANE, key: STORED_TOKEN, note: report.note })

      const restored = await savedFabricSettings({ env: { ...box.env, HOUDRY_FABRIC_KEY: '   ' }, note: report.note })

      assert.equal(restored.env.HOUDRY_FABRIC_KEY, STORED_TOKEN)
    })

    it('starts from nothing when no launch has saved anything', async (t) => {
      const box = sandbox(t)
      const report = collector()
      const restored = await savedFabricSettings({ env: box.env, note: report.note })

      assert.deepEqual(report.notes, [])
      assert.equal(restored.url, '')
      assert.equal(restored.key, '')
      assert.deepEqual(restored.env, box.env)
      assert.equal(fs.existsSync(box.document), false)
    })

    it('reconnects by discovery when the saved plane record cannot be read', async (t) => {
      const box = sandbox(t)
      const report = collector()

      fs.writeFileSync(box.connection, '{"url": "https://192.168.1.20:18080/v1"')

      const restored = await savedFabricSettings({ env: box.env, note: report.note })

      // A half-written address is not a plane to retry: it is no address, so the
      // launch falls through to the discovery that found this one in the first place.
      assert.equal(restored.url, '')
      assert.equal(restored.env.HOUDRY_FABRIC_URL, '')
      assert.deepEqual(report.notes, [])
    })

    it('reports a document it cannot read without quoting what is in it', async (t) => {
      const box = sandbox(t)
      const report = collector()

      writeDocument(box, `version: 99\nrefs:\n  HOUDRY_FABRIC_KEY: ${STORED_TOKEN}\n`)

      const restored = await savedFabricSettings({ env: box.env, note: report.note })

      assert.equal(restored.key, '')
      assert.equal(restored.env.HOUDRY_FABRIC_KEY, '')
      assert.ok(report.notes.some(line => line.includes('unreadable')), report.notes.join('\n'))
      assert.equal(report.notes.join('\n').includes(STORED_TOKEN), false)
    })
  })

  describe('saving what just authenticated', () => {
    it('keeps the token in the credential document and the plane in the trust directory', async (t) => {
      const box = sandbox(t)
      const report = collector()
      const saved = await saveFabricSettings({ env: box.env, url: PLANE, key: STORED_TOKEN, note: report.note })

      assert.equal(saved.tokenError, '')
      assert.equal(saved.connectionError, '')
      assert.equal(saved.tokenFile, box.document)
      assert.deepEqual(refsOf(box.document), [[FABRIC_KEY_REF, STORED_TOKEN]])
      // The plane file holds an address and nothing else: a token stored twice
      // is a token with one copy the product does not lock, watch, or rotate.
      assert.deepEqual(JSON.parse(fs.readFileSync(box.connection, 'utf8')), { url: PLANE })
      assert.equal(fs.readFileSync(box.connection, 'utf8').includes(STORED_TOKEN), false)
      assert.ok(report.notes.some(line => line.includes(FABRIC_KEY_REF)), report.notes.join('\n'))
    })

    it('folds in the entries the product already stored', async (t) => {
      const box = sandbox(t)
      const report = collector()

      writeDocument(box, 'version: 1\nrefs:\n  ANOTHER_PROVIDER_KEY: kept-as-written\n')

      await saveFabricSettings({ env: box.env, url: PLANE, key: STORED_TOKEN, note: report.note })

      assert.deepEqual(refsOf(box.document), [
        ['ANOTHER_PROVIDER_KEY', 'kept-as-written'],
        [FABRIC_KEY_REF, STORED_TOKEN]
      ])
    })

    it('refuses to rewrite a document this build cannot read, and leaves it byte for byte', async (t) => {
      const box = sandbox(t)
      const report = collector()
      const foreign = writeDocument(box, 'version: 99\nrefs:\n  HOUDRY_FABRIC_KEY: written-by-a-newer-build\n')

      const saved = await saveFabricSettings({ env: box.env, url: PLANE, key: STORED_TOKEN, note: report.note })

      assert.notEqual(saved.tokenError, '')
      assert.equal(fs.readFileSync(box.document, 'utf8'), foreign)
      // The plane address is not a credential, so it is still worth recording.
      assert.equal(saved.connectionError, '')
      assert.equal(fs.existsSync(box.connection), true)
    })

    it('stores neither a placeholder nor anything that is not a secret', async (t) => {
      const report = collector()

      for (const key of [PLACEHOLDER_FABRIC_KEY, '', 'abc', 'changeme', '   ']) {
        const box = sandbox(t)

        const saved = await saveFabricSettings({ env: box.env, url: PLANE, key, note: report.note })

        assert.equal(saved.tokenFile, '', `refused to store ${JSON.stringify(key)}`)
        assert.equal(saved.tokenError, '')
        assert.equal(fs.existsSync(box.document), false)
        assert.equal(fs.existsSync(box.connection), true)
      }
    })

    it('records an operator-chosen CA and never a pin the trust ladder chose', async (t) => {
      const box = sandbox(t)
      const without = sandbox(t)
      const report = collector()
      const ca = path.join(box.tofu, 'company-root.pem')

      await saveFabricSettings({ env: box.env, url: PLANE, ca, key: STORED_TOKEN, note: report.note })

      assert.deepEqual(JSON.parse(fs.readFileSync(box.connection, 'utf8')), { url: PLANE, ca })

      await saveFabricSettings({ env: without.env, url: PLANE, key: STORED_TOKEN, note: report.note })

      assert.equal(JSON.parse(fs.readFileSync(without.connection, 'utf8')).ca, undefined)
    })

    it('keeps a remembered operator CA through the launch that restored it', async (t) => {
      const box = sandbox(t)
      const report = collector()
      const ca = path.join(box.tofu, 'company-root.pem')

      await saveFabricSettings({ env: box.env, url: PLANE, ca, key: STORED_TOKEN, note: report.note })

      // What the next launch hands back to the store is what it restored, not what
      // the operator exported: an address and CA read from this file, then saved as
      // the bare environment view, would drop the CA one successful launch later.
      const restored = await savedFabricSettings({ env: box.env, note: report.note })
      const saved = await saveFabricSettings({
        env: box.env,
        url: restored.env.HOUDRY_FABRIC_URL,
        ca: String(restored.env.HOUDRY_FABRIC_CA ?? '').trim(),
        key: restored.env.HOUDRY_FABRIC_KEY === restored.key ? '' : restored.env.HOUDRY_FABRIC_KEY,
        note: report.note
      })

      assert.equal(saved.connectionError, '')
      assert.deepEqual(JSON.parse(fs.readFileSync(box.connection, 'utf8')), { url: PLANE, ca })
      assert.equal(fs.readFileSync(box.connection, 'utf8').includes(STORED_TOKEN), false)
    })

    it('keeps the credential document readable by its owner alone', async (t) => {
      const box = sandbox(t)
      const report = collector()

      await saveFabricSettings({ env: box.env, url: PLANE, key: STORED_TOKEN, note: report.note })

      if (process.platform === 'win32') {
        return
      }

      assert.equal(fs.statSync(box.document).mode & 0o077, 0)
    })
  })

  describe('reporting a credential the plane refused', () => {
    it('names the copy that lost, and never its value', () => {
      const exported = credentialUse({ usedKey: EXPORTED_TOKEN, storedKey: STORED_TOKEN })
      const stored = credentialUse({ usedKey: ` ${STORED_TOKEN} `, storedKey: STORED_TOKEN })

      assert.equal(exported.source, 'env')
      assert.match(exported.guide, /exported as HOUDRY_FABRIC_KEY/u)
      assert.match(exported.guide, /nothing was stored/u)
      assert.equal(stored.source, 'stored')
      assert.match(stored.guide, /credential document/u)
      assert.match(stored.guide, /left unchanged/u)
      // A token read back from the document is the document's own copy, so a
      // refusal must not offer to rewrite it with the value that just failed.
      assert.equal(stored.storableKey, '')
      assert.equal(exported.storableKey, EXPORTED_TOKEN)
      assert.notEqual(exported.guide, stored.guide)

      for (const guide of [exported.guide, stored.guide]) {
        assert.equal(guide.includes(EXPORTED_TOKEN), false)
        assert.equal(guide.includes(STORED_TOKEN), false)
      }
    })

    it('asks for a token when this launch had none', () => {
      for (const usedKey of [undefined, '', '   ']) {
        const none = credentialUse({ usedKey, storedKey: STORED_TOKEN })

        assert.equal(none.source, '')
        assert.equal(none.storableKey, '')
        assert.match(none.guide, /none was exported or stored/u)
        assert.match(none.guide, new RegExp(FABRIC_KEY_REF, 'u'))
        assert.equal(none.guide.includes(STORED_TOKEN), false)
      }
    })
  })

  describe('the launcher around it', () => {
    it('fails without reaching the plane, storing nothing and naming no secret', async (t) => {
      const box = sandbox(t)

      const foreign = writeDocument(box, `version: 99\nrefs:\n  HOUDRY_FABRIC_KEY: ${STORED_TOKEN}\n`)

      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../resolve.mjs', import.meta.url))], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          SystemRoot: process.env.SystemRoot,
          ...box.env,
          HOUDRY_FABRIC_URL: 'https://127.0.0.1:1/v1',
          HOUDRY_FABRIC_KEY: EXPORTED_TOKEN
        }
      })

      assert.equal(result.status, 2, result.stderr)
      // The launcher protocol is stdout, and nothing on it is for a human: a run
      // that resolved no plane prints no fields at all.
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /refusing to trust/u)
      // A document this build cannot read is reported as unreadable, and its
      // contents are still not repeated back.
      assert.match(result.stderr, /saved credentials are unreadable/u)
      assert.equal(result.stderr.includes(EXPORTED_TOKEN), false)
      assert.equal(result.stderr.includes(STORED_TOKEN), false)
      assert.equal(fs.readFileSync(box.document, 'utf8'), foreign)
      assert.equal(fs.existsSync(box.connection), false)
    })
  })
})
