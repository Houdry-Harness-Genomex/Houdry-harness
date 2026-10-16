// Manual, live-plane probe: a real chat completion through the CA pin the
// route carries. This is NOT a hermetic test and never runs under
// `pnpm test:houdry-fabric`; it needs a plane that answers.
//
//   HOUDRY_FABRIC_LIVE=1 node integrations/houdry-fabric/tests/provider-chat.manual.mjs
//
// The target and its CA come from the shipping path: the route in
// `$DSH_HOME/profiles/web/cordis.patch.yml` (override the address with
// HOUDRY_FABRIC_URL). No key is printed; failures name the cause, never the
// credential.

import fs from 'node:fs'
import https from 'node:https'

import { readFabricRoute, resolveFabricProfilePatchPath } from '../houdry-fabric-patch.mjs'

if (process.env.HOUDRY_FABRIC_LIVE !== '1') {
  console.log('This script talks to a live plane. Run it deliberately:')
  console.log('  HOUDRY_FABRIC_LIVE=1 node integrations/houdry-fabric/tests/provider-chat.manual.mjs')

  process.exit(0)
}

const route = readFabricRoute(resolveFabricProfilePatchPath(process.env))
const url = (process.env.HOUDRY_FABRIC_URL || route?.baseURL || '').replace(/\/$/, '')
const ca = route?.caFile && fs.existsSync(route.caFile) ? fs.readFileSync(route.caFile, 'utf8') : ''

console.log('=== Provider chat completion, through the route CA ===')
console.log(`Route baseURL: ${url || '(none — run the watcher once, or set HOUDRY_FABRIC_URL)'}`)
console.log(`Route caFile: ${route?.caFile ? `${route.caFile} (readable: ${ca !== ''})` : '(none)'}`)

if (!url) {
  process.exit(1)
}

const body = JSON.stringify({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 10
})

const chat = agent => new Promise((resolve, reject) => {
  const req = https.request(
    `${url}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${process.env.HOUDRY_FABRIC_KEY || 'no-key-required'}`
      },
      timeout: 10_000,
      agent
    },
    res => {
      const chunks = []

      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    }
  )

  req.on('timeout', () => {
    req.destroy(new Error('timed out after 10s'))
  })
  req.on('error', reject)
  req.write(body)
  req.end()
})

console.log('\n=== With the route CA pinned explicitly (the shipping ca-fetch path) ===')

try {
  const res = await chat(ca ? new https.Agent({ ca, rejectUnauthorized: true }) : undefined)

  console.log(`Status: ${res.statusCode}`)
  console.log(res.statusCode === 200 ? 'PASS' : `FAIL — body: ${res.body.slice(0, 400)}`)
} catch (error) {
  console.log(`FAIL — ${error.message}${error.code ? ` [${error.code}]` : ''}`)
}

console.log('\n=== With default trust alone (NODE_EXTRA_CA_CERTS, if the launcher exported it) ===')
console.log(`NODE_EXTRA_CA_CERTS: ${process.env.NODE_EXTRA_CA_CERTS || '(not set)'}`)

try {
  const res = await chat()

  console.log(`Status: ${res.statusCode}`)
  console.log(res.statusCode === 200 ? 'PASS' : `FAIL — body: ${res.body.slice(0, 400)}`)
} catch (error) {
  console.log(`FAIL — ${error.message}${error.code ? ` [${error.code}]` : ''}`)
}
