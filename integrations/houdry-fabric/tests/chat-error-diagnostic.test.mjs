// Diagnostic test to capture the actual error from a chat request to Fabric.
// This test attempts a real request and reports the detailed error with TLS,
// connection, and HTTP status information.

import https from 'node:https'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { houdryHttpsGet, pinnedCAForOrigin, defaultTofuFile } from '../houdry-tls.mjs'

const FABRIC_URL = process.env.HOUDRY_FABRIC_URL || 'https://192.168.1.36:18080/v1'
const TOFU_FILE = defaultTofuFile()

console.log('=== Fabric Chat Error Diagnostic ===')
console.log(`Fabric URL: ${FABRIC_URL}`)
console.log(`TOFU file: ${TOFU_FILE}`)

// Check NODE_EXTRA_CA_CERTS
console.log(`NODE_EXTRA_CA_CERTS: ${process.env.NODE_EXTRA_CA_CERTS || '(not set)'}`)

// Check pinned CA
const origin = new URL(FABRIC_URL).origin
const pinnedCA = pinnedCAForOrigin(origin, TOFU_FILE)
console.log(`Pinned CA exists: ${!!pinnedCA}`)
if (pinnedCA) {
  console.log(`Pinned CA length: ${pinnedCA.length} bytes`)
  console.log(`Pinned CA begins with: ${pinnedCA.substring(0, 50)}...`)
}

// Attempt a real chat request
const chatUrl = `${FABRIC_URL}/chat/completions`
console.log(`\nAttempting chat request to: ${chatUrl}`)

const requestBody = JSON.stringify({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 10
})

try {
  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      chatUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'Authorization': `Bearer ${process.env.HOUDRY_FABRIC_KEY || 'no-key-required'}`
        },
        timeout: 10000,
        // Use pinned CA if available
        agent: pinnedCA ? new https.Agent({ ca: pinnedCA, rejectUnauthorized: true }) : undefined
      },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout after 10s'))
    })

    req.on('error', error => {
      reject(error)
    })

    req.write(requestBody)
    req.end()
  })

  console.log(`\n=== Response ===`)
  console.log(`Status: ${response.statusCode} ${response.statusMessage}`)
  console.log(`Headers: ${JSON.stringify(response.headers, null, 2)}`)
  console.log(`Body: ${response.body}`)
} catch (error) {
  console.log(`\n=== Error ===`)
  console.log(`Error name: ${error.name}`)
  console.log(`Error message: ${error.message}`)
  console.log(`Error code: ${error.code}`)
  console.log(`Error cause: ${error.cause}`)
  console.log(`Full error:`, error)
}

// Test if NODE_EXTRA_CA_CERTS would be used by default https
console.log('\n=== Testing default HTTPS with NODE_EXTRA_CA_CERTS ===')
if (process.env.NODE_EXTRA_CA_CERTS) {
  try {
    const caContent = readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8')
    console.log(`CA file exists and is ${caContent.length} bytes`)
    console.log(`CA begins with: ${caContent.substring(0, 50)}...`)
  } catch (e) {
    console.log(`CA file read error: ${e.message}`)
  }
}
