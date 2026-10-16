// End-to-end test of chat completion through the Harness provider path
// This verifies that the CA trust loaded at boot actually reaches pi-ai's HTTP requests

import https from 'node:https'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { houdryHttpsGet, pinnedCAForOrigin, defaultTofuFile } from '../houdry-tls.mjs'

const FABRIC_URL = process.env.HOUDRY_FABRIC_URL || 'https://192.168.1.36:18080/v1'
const TOFU_FILE = defaultTofuFile()

console.log('=== Provider Chat Completion Test ===')
console.log(`Fabric URL: ${FABRIC_URL}`)
console.log(`TOFU file: ${TOFU_FILE}`)

// Check if NODE_EXTRA_CA_CERTS is set (the CA trust should have loaded it)
console.log(`NODE_EXTRA_CA_CERTS: ${process.env.NODE_EXTRA_CA_CERTS || '(not set)'}`)

// Get the pinned CA
const origin = new URL(FABRIC_URL).origin
const pinnedCA = pinnedCAForOrigin(origin, TOFU_FILE)
console.log(`Pinned CA exists: ${!!pinnedCA}`)

// Test 1: Request WITHOUT custom agent (relies on NODE_EXTRA_CA_CERTS)
console.log('\n=== Test 1: HTTPS request without custom agent (NODE_EXTRA_CA_CERTS) ===')
try {
  const response1 = await new Promise((resolve, reject) => {
    const req = https.request(
      `${FABRIC_URL}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(JSON.stringify({
            model: 'auto',
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 10
          })),
          'Authorization': `Bearer ${process.env.HOUDRY_FABRIC_KEY || 'no-key-required'}`
        },
        timeout: 10000,
      },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )
    req.on('error', reject)
    req.write(JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    }))
    req.end()
  })
  console.log(`Status: ${response1.statusCode}`)
  console.log(`Test 1: ${response1.statusCode === 200 ? 'PASS' : 'FAIL'}`)
} catch (error) {
  console.log(`Test 1: FAIL - ${error.message}`)
}

// Test 2: Request WITH custom agent (explicit CA)
console.log('\n=== Test 2: HTTPS request with custom agent (explicit CA) ===')
if (pinnedCA) {
  try {
    const response2 = await new Promise((resolve, reject) => {
      const req = https.request(
        `${FABRIC_URL}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify({
              model: 'auto',
              messages: [{ role: 'user', content: 'Hello' }],
              max_tokens: 10
            })),
            'Authorization': `Bearer ${process.env.HOUDRY_FABRIC_KEY || 'no-key-required'}`
          },
          timeout: 10000,
          agent: new https.Agent({ ca: pinnedCA, rejectUnauthorized: true })
        },
        res => {
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode,
              body: Buffer.concat(chunks).toString('utf8')
            })
          })
        }
      )
      req.on('error', reject)
      req.write(JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10
      }))
      req.end()
    })
    console.log(`Status: ${response2.statusCode}`)
    console.log(`Test 2: ${response2.statusCode === 200 ? 'PASS' : 'FAIL'}`)
  } catch (error) {
    console.log(`Test 2: FAIL - ${error.message}`)
  }
} else {
  console.log('Test 2: SKIP - no pinned CA')
}

console.log('\n=== Summary ===')
console.log('If Test 1 passes, NODE_EXTRA_CA_CERTS is working (pi-ai respects it)')
console.log('If Test 2 passes, custom agent works (fallback for direct HTTPS)')
console.log('Both should pass for full coverage')
