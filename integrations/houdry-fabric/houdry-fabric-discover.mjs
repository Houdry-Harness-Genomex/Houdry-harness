// Finding a Houdry fabric control plane on the local network, ported from the
// Houdry Agent's apps/desktop/electron/houdry-fabric-discover.ts.
//
// The agent browses two transports that carry the same information, because
// each one fails somewhere the other works:
//
//   - UDP probe/response on 41808 (broadcast + 239.255.77.77). The fabric calls
//     this "more reliable on Windows", and it is what `houdry discover` prints.
//   - mDNS/DNS-SD, service type _houdry._tcp in local. — the transport every
//     Bonjour/Avahi host already speaks, so a plane advertises into an existing
//     network browse instead of needing a firewall hole for 41808.
//
// Wire formats come from the fabric's internal/discovery package: the JSON
// message in protocol.go, the TXT records in txtRecords(), and the acceptance
// rule in endpointFromUDP() — kind, version, and a non-empty url, nothing else
// trusted. Both replies carry the base URL, so the API address is never guessed.
//
// The agent's other invariants, kept deliberately:
//
//   - discovery never throws. A closed firewall or a guest SSID looks exactly
//     like "nothing found", and that must not be a stack trace.
//   - loopback advertisements are dropped, not preferred: a leftover `houdry
//     serve` on this machine answering 127.0.0.1 is not the control plane the
//     user is standing next to on WiFi.
//   - one `serve` process answers on every NIC (WiFi plus WSL/Hyper-V), and
//     those replies share an instance name. They must collapse to one plane and
//     keep the real WiFi address, scored by range and by which NIC owns it.

import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'

import { houdryHttpsGet, rewriteHoudryHttps } from './houdry-tls.mjs'

/** Keep in sync with houdry/internal/discovery (UDPPort). */
export const HOUDRY_FABRIC_UDP_PORT = 41_808
export const HOUDRY_FABRIC_MULTICAST = '239.255.77.77'
export const HOUDRY_FABRIC_DISCOVER_WAIT_MS = 2_000

/** Keep in sync with discovery.ServiceType / Domain. */
export const HOUDRY_MDNS_SERVICE_TYPE = '_houdry._tcp'
export const HOUDRY_MDNS_DOMAIN = 'local'
export const MDNS_GROUP = '224.0.0.251'
export const MDNS_PORT = 5353

const PROBE = Buffer.from(JSON.stringify({ houdry: 'discover', v: 1 }))
const PROTOCOL_V = 1
const DEFAULT_PATH = '/v1'

/**
 * Parse a UDP advertisement. Rejects probes, junk, and any newer schema, the
 * same three ways as endpointFromUDP.
 */
export function parseHoudryAdvertise(raw) {
  let msg

  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }

  if (msg.houdry !== 'control-plane' || msg.v !== PROTOCOL_V || !msg.url) {
    return null
  }

  const url = rewriteHoudryHttps(String(msg.url).replace(/\/+$/, ''))
  const path = typeof msg.path === 'string' && msg.path.startsWith('/') ? msg.path : DEFAULT_PATH

  return {
    name: typeof msg.name === 'string' ? msg.name.trim() : '',
    url,
    api: `${url}${path}`,
    ...(msg.version ? { version: String(msg.version) } : {}),
    auth: Boolean(msg.auth),
    openai: msg.openai === undefined ? true : Boolean(msg.openai),
    source: 'udp',
  }
}

/**
 * The fabric's identity document (server.go handleWellKnown): `{houdry:
 * "control-plane", v: 1}` plus version, path, openai, auth, tls and enroll.
 * Checking the body rather than only the status code is what stops a squatter
 * on 18080 — Cursor, a WSL relay, another bench — from being adopted.
 */
export function isControlPlaneWellKnown(body) {
  if (!body || typeof body !== 'object') {
    return false
  }

  return body.houdry === 'control-plane' && body.v === PROTOCOL_V
}

/**
 * True when this origin serves GET /.well-known/houdry.json as a v1 control
 * plane. TLS is deliberately not verified here: this probe is how we decide
 * whether the plane is worth pinning, and identity comes from the pin.
 */
export async function probeHoudryControlPlane(origin, { timeoutMs = 2_000, tofuFile = '', fetchImpl = houdryHttpsGet } = {}) {
  let url

  try {
    url = `${new URL(rewriteHoudryHttps(origin)).origin}/.well-known/houdry.json`
  } catch {
    return false
  }

  const res = await fetchImpl(url, { insecure: true, timeoutMs, skipPin: true, tofuFile })

  if (!res.ok) {
    return false
  }

  try {
    return isControlPlaneWellKnown(JSON.parse(res.body))
  } catch {
    return false
  }
}

/** GET /healthz as the fabric's own client does when /.well-known is unavailable. */
export async function probeHoudryHealth(origin, { timeoutMs = 1_500, fetchImpl = houdryHttpsGet } = {}) {
  try {
    const res = await fetchImpl(`${new URL(rewriteHoudryHttps(origin)).origin}/healthz`, {
      insecure: true,
      timeoutMs,
      skipPin: true,
    })

    return res.ok
  } catch {
    return false
  }
}

/**
 * Reachability, the agent's way: the identity document decides, and a plane
 * that answers /healthz but not /.well-known — an older build behind a proxy
 * that strips it — is still reachable.
 */
export async function isPlaneReachable(origin, opts = {}) {
  return (await probeHoudryControlPlane(origin, opts)) || (await probeHoudryHealth(origin, opts))
}

export function ipv4IsAssignedToThisHost(host, ifaces = networkInterfaces()) {
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (String(addr.family) === 'IPv4' && addr.address === host) {
        return true
      }
    }
  }

  return false
}

/**
 * Rewrite an advertisement whose IP belongs to this computer to 127.0.0.1, so
 * an agent running on the plane host never pins a WiFi or WSL address for a
 * control plane it could reach over loopback. Used for the explicit
 * "this computer" choice; the WiFi browse path drops loopback instead.
 */
export function preferLoopbackIfLocal(ep, ifaces = networkInterfaces()) {
  let parsed

  try {
    parsed = new URL(ep.url)
  } catch {
    return ep
  }

  const host = parsed.hostname
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')

  if (host === '127.0.0.1' || host === 'localhost') {
    const url = `https://127.0.0.1:${port}`

    return { ...ep, url, api: `${url}/v1` }
  }

  if (!ipv4IsAssignedToThisHost(host, ifaces)) {
    const url = rewriteHoudryHttps(ep.url)
    const api = rewriteHoudryHttps(ep.api)

    return url === ep.url && api === ep.api ? ep : { ...ep, url, api }
  }

  const url = `https://127.0.0.1:${port}`

  return { ...ep, url, api: `${url}/v1` }
}

/** Hyper-V/WSL/VM NICs are not the WiFi the user is picking a control plane on. */
export const VIRTUAL_IFACE_NAME = /vEthernet|WSL|Hyper-V|docker|VMware|VirtualBox|vboxnet|vmnet|ZeroTier|Hamachi/i

function isLoopbackFabricHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()

    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

/**
 * Collapse what one `houdry serve` answered on several NICs into one endpoint,
 * and keep the address a peer on the WiFi would actually use.
 */
export function uniqueFabricEndpoints(list, ifaces = networkInterfaces()) {
  const rewritten = list
    .map(ep => {
      const url = rewriteHoudryHttps(ep.url)
      const api = rewriteHoudryHttps(ep.api)

      return url === ep.url && api === ep.api ? ep : { ...ep, url, api }
    })
    .filter(ep => !isLoopbackFabricHost(ep.url))

  const seenUrl = new Map()
  const byUrl = []

  for (const ep of rewritten) {
    const existing = seenUrl.get(ep.url)

    if (existing === undefined) {
      seenUrl.set(ep.url, byUrl.length)
      byUrl.push(ep)
      continue
    }

    if (!byUrl[existing].name && ep.name) {
      byUrl[existing] = { ...ep }
    }
  }

  const seenName = new Map()
  const out = []

  for (const ep of byUrl) {
    const name = ep.name.trim()

    if (name) {
      const existing = seenName.get(name)

      if (existing !== undefined) {
        if (lanPickScore(ep, ifaces) > lanPickScore(out[existing], ifaces)) {
          out[existing] = ep
        }
        continue
      }

      seenName.set(name, out.length)
    }

    out.push(ep)
  }

  return out
}

function ifaceNameForIpv4(host, ifaces) {
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs ?? []) {
      if (String(addr.family) === 'IPv4' && addr.address === host) {
        return name
      }
    }
  }

  return null
}

function lanPickScore(ep, ifaces) {
  let score = lanAddressScore(ep.url)

  try {
    const iface = ifaceNameForIpv4(new URL(ep.url).hostname, ifaces)

    if (iface && !VIRTUAL_IFACE_NAME.test(iface)) {
      score += 25
    }
  } catch {
    // Keep the RFC1918 score alone when the URL will not parse.
  }

  return score
}

/** Higher is a better pick for "this WiFi": prefer 192.168 over WSL/Hyper-V 172.x. */
export function lanAddressScore(urlOrHost) {
  let host = urlOrHost

  try {
    host = urlOrHost.includes('://') ? new URL(urlOrHost).hostname : urlOrHost.split(':')[0]
  } catch {
    return 5
  }

  const parts = host.split('.').map(Number)

  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 5
  }

  const [a, b] = parts

  if (a === 127) {
    return 50
  }

  if (a === 192 && b === 168) {
    return 40
  }

  if (a === 10) {
    return 30
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return 10
  }

  if (a === 169 && b === 254) {
    return 0
  }

  return 20
}

/** IPv4 directed broadcast for an address/netmask pair, or null if the pair is unusable. */
export function ipv4Broadcast(address, netmask) {
  const ip = String(address).split('.').map(Number)
  const mask = String(netmask).split('.').map(Number)

  if (ip.length !== 4 || mask.length !== 4) {
    return null
  }

  if (ip.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null
  }

  if (mask.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null
  }

  return ip.map((octet, i) => octet | (~mask[i] & 255)).join('.')
}

export function udpBroadcastTargets(ifaces = networkInterfaces()) {
  const out = ['255.255.255.255', HOUDRY_FABRIC_MULTICAST]
  const seen = new Set(out)

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || VIRTUAL_IFACE_NAME.test(name)) {
      continue
    }

    for (const addr of addrs) {
      const family = String(addr.family)

      if (addr.internal || (family !== 'IPv4' && family !== '4')) {
        continue
      }

      const bcast = ipv4Broadcast(addr.address, addr.netmask)

      if (!bcast || seen.has(bcast)) {
        continue
      }

      seen.add(bcast)
      out.push(bcast)
    }
  }

  return out
}

/** Probe the LAN over UDP and return the advertisements, deduplicated. */
export function listenForAdvertise(waitMs = HOUDRY_FABRIC_DISCOVER_WAIT_MS) {
  return new Promise(resolve => {
    const found = []
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false

    const finish = () => {
      if (settled) {
        return
      }

      settled = true

      try {
        sock.close()
      } catch {
        // Already closed.
      }

      resolve(found)
    }

    sock.on('message', msg => {
      const ep = parseHoudryAdvertise(msg.toString('utf8'))

      if (ep) {
        found.push(ep)
      }
    })
    sock.on('error', finish)
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true)
      } catch {
        finish()
        return
      }

      for (const ip of udpBroadcastTargets()) {
        try {
          sock.send(PROBE, HOUDRY_FABRIC_UDP_PORT, ip, () => {
            // Ignore per-target send errors (no route, interface down).
          })
        } catch {
          // A target this host cannot reach is not a discovery failure.
        }
      }
    })

    setTimeout(finish, Math.max(200, waitMs))
  })
}

// --- mDNS/DNS-SD ------------------------------------------------------------
//
// A minimal browser: one PTR question, then SRV/TXT/A/AAAA out of the answers
// and additionals. No dependency, because a name-compression DNS parser is
// smaller than the zeroconf packages that would carry it, and the payload this
// has to understand is fixed by the fabric.

const TYPE_PTR = 12
const TYPE_TXT = 16
const TYPE_A = 1
const TYPE_AAAA = 28
const TYPE_SRV = 33

function encodeName(name) {
  const labels = name.split('.').filter(Boolean)
  const parts = labels.map(label => {
    const bytes = Buffer.from(label, 'utf8')
    const len = Buffer.alloc(1)

    len.writeUInt8(bytes.length, 0)

    return Buffer.concat([len, bytes])
  })

  return Buffer.concat([...parts, Buffer.alloc(1)])
}

/**
 * One PTR question for the houdry service type: a 12-byte header with QDCOUNT=1
 * and name + QTYPE + QCLASS. The name is variable length, so the two trailing
 * fields are written relative to it — an off-by-one here is a RangeError on the
 * way out, and a browser that cannot ask is indistinguishable from an empty LAN.
 */
export function mdnsQueryPacket(name = `${HOUDRY_MDNS_SERVICE_TYPE}.${HOUDRY_MDNS_DOMAIN}`) {
  const encoded = encodeName(name)
  const question = Buffer.alloc(encoded.length + 4)

  encoded.copy(question)
  question.writeUInt16BE(TYPE_PTR, encoded.length)
  question.writeUInt16BE(1, encoded.length + 2) // class IN

  const header = Buffer.alloc(12)

  header.writeUInt16BE(1, 4) // one question

  return Buffer.concat([header, question])
}

/** Read a possibly compressed DNS name, following pointers with a loop guard. */
function readName(buf, offset) {
  const labels = []
  let i = offset
  let next = offset
  let jumped = false
  let guard = 0

  while (i < buf.length && guard++ < 64) {
    const len = buf.readUInt8(i)

    if (len === 0) {
      if (!jumped) {
        next = i + 1
      }
      break
    }

    if ((len & 0xc0) === 0xc0) {
      if (i + 1 >= buf.length) {
        break
      }

      const pointer = ((len & 0x3f) << 8) | buf.readUInt8(i + 1)

      if (!jumped) {
        next = i + 2
      }
      jumped = true
      i = pointer
      continue
    }

    if ((len & 0xc0) !== 0) {
      break // reserved label type; treat the name as ended
    }

    labels.push(buf.slice(i + 1, i + 1 + len).toString('utf8'))
    i += 1 + len

    if (!jumped) {
      next = i
    }
  }

  return { name: labels.join('.'), next }
}

function parseRecords(buf, qdcount) {
  const questionEnd = (() => {
    let i = 12

    for (let q = 0; q < qdcount; q++) {
      i = readName(buf, i).next + 4
    }

    return i
  })()

  const counts = [
    buf.readUInt16BE(6),
    buf.readUInt16BE(8),
    buf.readUInt16BE(10),
  ]
  const records = []
  let i = questionEnd

  for (const count of counts) {
    for (let r = 0; r < count && i < buf.length; r++) {
      const name = readName(buf, i)
      const rr = name.next

      if (rr + 10 > buf.length) {
        return records
      }

      const type = buf.readUInt16BE(rr)
      const rdLength = buf.readUInt16BE(rr + 8)
      const dataStart = rr + 10
      const data = buf.slice(dataStart, dataStart + rdLength)

      records.push({ name: name.name.toLowerCase(), type, data, dataStart })
      i = dataStart + rdLength
    }
  }

  return records
}

function parseTXT(records) {
  const fields = {}

  for (const rec of records) {
    let i = 0

    while (i < rec.data.length) {
      const len = rec.data.readUInt8(i)
      const text = rec.data.slice(i + 1, i + 1 + len).toString('utf8')

      i += 1 + len

      const eq = text.indexOf('=')

      if (eq < 0) {
        continue
      }

      fields[text.slice(0, eq).trim()] = text.slice(eq + 1).trim()
    }
  }

  return fields
}

function ipv4FromA(records) {
  for (const rec of records) {
    if (rec.type === TYPE_A && rec.data.length === 4) {
      return rec.data.join('.')
    }
  }

  return null
}

function ipv6FromAAAA(records) {
  for (const rec of records) {
    if (rec.type === TYPE_AAAA && rec.data.length === 16) {
      return [...rec.data.entries()].reduce((acc, [, b]) => acc + b.toString(16).padStart(2, '0'), '').replace(/(.{4})/g, '$1:').replace(/:$/, '')
    }
  }

  return null
}

/**
 * DNS-SD answers for one service instance into an endpoint. The instance name
 * is the plane's name (zeroconf.Register's first argument), the TXT records are
 * txtRecords() in the fabric, and the address comes from the SRV port plus an A
 * or AAAA for its target.
 */
export function endpointsFromMDNSAnswer(buf) {
  let header

  try {
    if (buf.length < 12) {
      return []
    }

    header = { qd: buf.readUInt16BE(4), answers: buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10) }
  } catch {
    return []
  }

  if (header.answers === 0) {
    return []
  }

  const records = parseRecords(buf, header.qd).filter(Boolean)
  const suffix = `.${HOUDRY_MDNS_SERVICE_TYPE}.${HOUDRY_MDNS_DOMAIN}`

  // An A/AAAA is keyed by the SRV *target*, not by the service instance name,
  // so addresses are collected by host name and looked up per instance.
  const addresses = new Map()

  for (const rec of records) {
    if (rec.type !== TYPE_A && rec.type !== TYPE_AAAA) {
      continue
    }

    if (!addresses.has(rec.name)) {
      addresses.set(rec.name, rec)
    }
  }

  const byInstance = new Map()

  const bucket = instance => {
    const existing = byInstance.get(instance)

    if (existing) {
      return existing
    }

    const fresh = { ptr: [], srv: [], txt: [] }

    byInstance.set(instance, fresh)

    return fresh
  }

  for (const rec of records) {
    if (!rec.name.endsWith(suffix)) {
      continue
    }

    const instance = rec.name.slice(0, -suffix.length)

    if (!instance) {
      continue
    }

    const b = bucket(instance)

    if (rec.type === TYPE_PTR) {
      b.ptr.push(readName(buf, rec.dataStart).name)
    } else if (rec.type === TYPE_SRV) {
      b.srv.push(rec)
    } else if (rec.type === TYPE_TXT) {
      b.txt.push(rec)
    }
  }

  const out = []

  for (const [instance, b] of byInstance) {
    if (b.srv.length === 0) {
      continue
    }

    const srv = b.srv[0]
    const port = srv.data.length >= 6 ? srv.data.readUInt16BE(4) : 0
    const target = readName(buf, srv.dataStart + 6).name
    const address = addresses.get(target.toLowerCase()) ?? addresses.get(`${target.toLowerCase()}.`)
    const fields = parseTXT(b.txt)

    if (!address || port <= 0) {
      continue
    }

    const host = address.type === TYPE_A ? ipv4FromA([address]) : ipv6FromAAAA([address])

    if (!host) {
      continue
    }

    const path = fields.path?.startsWith('/') ? fields.path : DEFAULT_PATH
    const bracketed = host.includes(':') ? `[${host}]` : host
    const url = `https://${bracketed}:${port}`

    out.push({
      name: instance,
      url,
      api: `${url}${path}`,
      ...(fields.version ? { version: fields.version } : {}),
      auth: fields.auth === '1' || fields.auth === 'true',
      // The fabric writes openai=0 only when the compat surface is disabled.
      openai: fields.openai !== '0' && fields.openai !== 'false',
      source: 'mdns',
      target
    })
  }

  return out
}

/**
 * Browse _houdry._tcp over mDNS. Never throws: an OS that will not let this
 * process hold port 5353, or a network with no responder, both look like an
 * empty result, and the UDP probe covers that case.
 */
export function listenForMDNS(waitMs = HOUDRY_FABRIC_DISCOVER_WAIT_MS) {
  return new Promise(resolve => {
    const found = []
    let sock

    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    } catch {
      resolve(found)
      return
    }

    let settled = false

    const finish = () => {
      if (settled) {
        return
      }

      settled = true

      try {
        sock.close()
      } catch {
        // Already closed.
      }

      resolve(found)
    }

    const packet = mdnsQueryPacket()

    sock.on('message', msg => {
      found.push(...endpointsFromMDNSAnswer(msg))
    })
    sock.on('error', finish)

    sock.bind(() => {
      try {
        sock.setMulticastTTL(255)
        sock.setBroadcast(true)
        sock.addMembership(MDNS_GROUP)
      } catch {
        // Unicast answers still reach a bound socket; a failed join is not fatal.
      }

      try {
        sock.send(packet, MDNS_PORT, MDNS_GROUP, () => {})
      } catch {
        finish()
      }
    })

    setTimeout(finish, Math.max(200, waitMs))
  })
}

/**
 * Browse both transports and return the unique planes. The agent's contract:
 * never throw, always answer.
 */
export async function discoverHoudryFabric(
  waitMs = HOUDRY_FABRIC_DISCOVER_WAIT_MS,
  { ifaces = networkInterfaces(), mdns = true } = {}
) {
  const browses = [quietListen(listenForAdvertise(waitMs))]

  if (mdns) {
    browses.push(quietListen(listenForMDNS(waitMs)))
  }

  const replies = await Promise.all(browses)
  const raw = replies.flat()

  // A reply parsed off the wire that is not a control plane is dropped by
  // parseHoudryAdvertise; an mDNS service without address records is dropped
  // here, because there is nothing to connect to.
  try {
    return uniqueFabricEndpoints(raw, ifaces)
  } catch {
    return []
  }
}

/** A rejected browse is "nobody answered", never an error the caller must handle. */
function quietListen(promise) {
  return Promise.resolve(promise).catch(() => [])
}
