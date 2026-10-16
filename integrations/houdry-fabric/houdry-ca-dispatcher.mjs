// CA trust for Houdry Fabric endpoints using NODE_EXTRA_CA_CERTS.
//
// This module provides a function to set NODE_EXTRA_CA_CERTS at runtime,
// which is needed because the Fabric launcher scripts set it before starting
// dsh, but when running `pnpm run start:web` directly the variable is not set.
//
// Node reads NODE_EXTRA_CA_CERTS only at process startup, so this function
// must be called very early in the boot process. It works by:
// 1. Finding the pinned CA for the active Fabric route
// 2. Writing it to a temporary file
// 3. Setting NODE_EXTRA_CA_CERTS to that file
// 4. Calling process.emit('NODE_EXTRA_CA_CERTS_UPDATED') which some libraries
//    (like undici) respect to reload the CA at runtime

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { defaultTofuFile, pinnedCAForOrigin } from './houdry-tls.mjs'

/**
 * Load the pinned Fabric CA and configure Node to trust it.
 * This finds the CA from the TOFU store for the current Fabric route and
 * makes it available to all HTTPS requests by setting NODE_EXTRA_CA_CERTS.
 * @param tofuFile - Optional path to the TOFU store; defaults to ~/.houdry-dsh/houdry-tofu-ca.json
 * @returns A function that restores the original NODE_EXTRA_CA_CERTS value
 */
export function loadFabricCATrust(tofuFile = defaultTofuFile()) {
  const originalNodeExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS

  // Try to find the CA from the most recently used Fabric origin
  const store = JSON.parse(fs.readFileSync(tofuFile, 'utf8'))
  const origins = Object.keys(store)
  if (origins.length === 0) {
    return () => {}
  }

  // Use the most recently pinned origin (last in the file)
  const origin = origins[origins.length - 1]
  const pinnedCA = store[origin]?.pem
  if (!pinnedCA) {
    return () => {}
  }

  // Write the CA to a temporary file
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'houdry-ca-'))
  const tempCaFile = path.join(tempDir, 'fabric-ca.crt')
  fs.writeFileSync(tempCaFile, pinnedCA, { mode: 0o644 })

  // Set NODE_EXTRA_CA_CERTS
  process.env.NODE_EXTRA_CA_CERTS = tempCaFile

  // Notify undici to reload the CA (undici respects this event)
  process.emit('NODE_EXTRA_CA_CERTS_UPDATED')

  return () => {
    if (originalNodeExtraCaCerts === undefined) {
      delete process.env.NODE_EXTRA_CA_CERTS
    } else {
      process.env.NODE_EXTRA_CA_CERTS = originalNodeExtraCaCerts
    }
    try {
      fs.unlinkSync(tempCaFile)
      fs.rmdirSync(tempDir)
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Get a custom https.Agent for a specific Fabric origin with its pinned CA.
 * This can be used by code that needs an explicit agent (e.g., direct https requests).
 * @param origin - The Fabric origin (e.g., https://192.168.1.36:18080)
 * @param tofuFile - Optional path to the TOFU store
 * @returns An https.Agent configured with the pinned CA, or undefined if no CA is pinned
 */
export function httpsAgentForFabric(origin, tofuFile = defaultTofuFile()) {
  const pinnedCA = pinnedCAForOrigin(origin, tofuFile)
  if (!pinnedCA) {
    return undefined
  }
  return new https.Agent({
    ca: pinnedCA,
    rejectUnauthorized: true
  })
}
