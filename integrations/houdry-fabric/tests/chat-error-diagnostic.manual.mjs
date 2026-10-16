// Manual, live-plane diagnostic: capture the REAL underlying error of a chat
// request against a fabric plane — TLS cause, connection code, HTTP status —
// instead of the bare "Connection error." the OpenAI SDK collapses it into.
// NOT a hermetic test; never runs under `pnpm test:houdry-fabric`.
//
//   HOUDRY_FABRIC_LIVE=1 node integrations/houdry-fabric/tests/chat-error-diagnostic.manual.mjs
//
// The target and its CA come from the route in
// `$DSH_HOME/profiles/web/cordis.patch.yml` (override with HOUDRY_FABRIC_URL).
// No key is ever printed.

import fs from 'node:fs'
import https from 'node:https'

import { readFabricRoute, resolveFabricProfilePatchPath } from '../houdry-fabric-patch.mjs'

if (process.env.HOUDRY_FABRIC_LIVE !== '1') {
  console.log('This script talks to a live plane. Run it deliberately:')
  console.log('  HOUDRY_FABRIC_LIVE=1 node integrations/houdry-fabric/tests/chat-error-diagnostic.manual.mjs')

  process.exit(0)
}

const route = readFabricRoute(resolveFabricProfilePatchPath(process.env))
const url = (process.env.HOUDRY_FABRIC_URL || route?.baseURL || '').replace(/\/$/, '')
const ca = route?.caFile && fs.existsSync(route.caFile) ? fs.readFileSync(route.caFile, 'utf8') : ''

console.log('=== Fabric chat error diagnostic ===')
console.log(`Route baseURL: ${url || '(none — run the watcher once, or set HOUDRY_FABRIC_URL)'}`)
console.log(`Route caFile: ${route?.caFile ? `${route.caFile} (readable: ${ca !== ''})` : '(none)'}`)
console.log(`NODE_EXTRA_CA_CERTS: ${process.env.NODE_EXTRA_CA_CERTS || '(not set)'}`)

if (!url) {
  process.exit(1)
}

const body = JSON.stringify({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 10
})

console.log(`\nAttempting chat request to: ${url}/chat/completions`)

try {
  const res = await new Promise((resolve, reject) => {
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
        agent: ca ? new https.Agent({ ca, rejectUnauthorized: true }) : undefined
      },
      response => {
        const chunks = []

        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }))
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('timed out after 10s'))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })

  console.log('\n=== Response ===')
  console.log(`Status: ${res.statusCode} ${res.statusMessage}`)
  console.log(`Headers: ${JSON.stringify(res.headers, null, 2)}`)
  console.log(`Body: ${res.body}`)
} catch (error) {
  console.log('\n=== Error (the detail "Connection error." hides) ===')
  console.log(`Name: ${error.name}`)
  console.log(`Message: ${error.message}`)
  console.log(`Code: ${error.code ?? '(none)'}`)

  let cause = error.cause
  let depth = 0

  while (cause && depth < 5) {
    console.log(`Cause ${depth + 1}: ${cause.name ?? typeof cause}: ${cause.message ?? String(cause)}${cause.code ? ` [${cause.code}]` : ''}`)
    cause = cause.cause
    depth += 1
  }
}
