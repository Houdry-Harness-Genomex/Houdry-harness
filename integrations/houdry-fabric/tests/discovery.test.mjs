// Contracts ported from the Houdry Agent's apps/desktop/electron/
// houdry-fabric-discover.test.ts, plus the mDNS browser the Agent does not have
// a unit test for. Same assertions where the behavior is supposed to be the
// same, because those tests are the specification of what "found the plane"
// means: which replies are accepted, and which of several addresses of one
// plane a client ends up using.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  discoverHoudryFabric,
  endpointsFromMDNSAnswer,
  ipv4Broadcast,
  isControlPlaneWellKnown,
  ipv4IsAssignedToThisHost,
  listenForAdvertise,
  mdnsQueryPacket,
  parseHoudryAdvertise,
  preferLoopbackIfLocal,
  udpBroadcastTargets,
  uniqueFabricEndpoints,
  lanAddressScore
} from '../houdry-fabric-discover.mjs'
import { houdryMDNSAnswer, dnsHeader, dnsQuestion, dnsName, dnsRecord, TYPE_PTR } from './fixtures.mjs'

describe('parseHoudryAdvertise', () => {
  it('accepts a v1 control-plane reply', () => {
    const ep = parseHoudryAdvertise(
      JSON.stringify({
        houdry: 'control-plane',
        v: 1,
        url: 'http://192.168.1.10:8080',
        path: '/v1',
        name: 'houdry-lab',
        version: '0.6.0',
        auth: true,
        openai: true
      })
    )

    // https, even though the advertisement said http: houdry serve is TLS-only.
    assert.deepEqual(ep, {
      name: 'houdry-lab',
      url: 'https://192.168.1.10:8080',
      api: 'https://192.168.1.10:8080/v1',
      version: '0.6.0',
      auth: true,
      openai: true,
      source: 'udp'
    })
  })

  it('defaults the API path to /v1 and strips a trailing slash', () => {
    const ep = parseHoudryAdvertise(JSON.stringify({ houdry: 'control-plane', v: 1, url: 'http://10.0.0.5:8080/' }))

    assert.equal(ep.api, 'https://10.0.0.5:8080/v1')
    assert.equal(ep.url, 'https://10.0.0.5:8080')
  })

  it('ignores probes and junk', () => {
    assert.equal(parseHoudryAdvertise(JSON.stringify({ houdry: 'discover', v: 1 })), null)
    assert.equal(parseHoudryAdvertise('not json'), null)
    assert.equal(parseHoudryAdvertise(JSON.stringify({ houdry: 'control-plane', v: 2, url: 'http://x' })), null)
    assert.equal(parseHoudryAdvertise(JSON.stringify({ houdry: 'control-plane', v: 1 })), null)
  })

  it('keeps a path the plane advertises instead of forcing /v1', () => {
    const ep = parseHoudryAdvertise(JSON.stringify({ houdry: 'control-plane', v: 1, url: 'https://10.0.0.5:8080', path: '/gateway/v1' }))

    assert.equal(ep.api, 'https://10.0.0.5:8080/gateway/v1')
  })
})

describe('isControlPlaneWellKnown', () => {
  it('accepts the v1 identity document', () => {
    assert.equal(isControlPlaneWellKnown({ houdry: 'control-plane', v: 1, path: '/v1' }), true)
  })

  it('rejects anything else', () => {
    assert.equal(isControlPlaneWellKnown({ houdry: 'control-plane', v: 2 }), false)
    assert.equal(isControlPlaneWellKnown({ ok: true }), false)
    assert.equal(isControlPlaneWellKnown(null), false)
  })
})

describe('uniqueFabricEndpoints', () => {
  const ifaces = {}

  it('dedupes by URL and keeps a name when a later reply has one', () => {
    const out = uniqueFabricEndpoints(
      [
        { name: '', url: 'https://a:8080', api: 'https://a:8080/v1', auth: false, openai: true },
        { name: 'desk', url: 'https://a:8080', api: 'https://a:8080/v1', auth: false, openai: true },
        { name: 'other', url: 'https://b:8080', api: 'https://b:8080/v1', auth: false, openai: true }
      ],
      ifaces
    )

    assert.equal(out.length, 2)
    assert.equal(out[0].name, 'desk')
    assert.equal(out[1].name, 'other')
  })

  it('drops loopback advertisements instead of preferring them over WiFi', () => {
    const out = uniqueFabricEndpoints(
      [
        { name: 'leftover-local', url: 'https://127.0.0.1:18080', api: 'https://127.0.0.1:18080/v1', auth: false, openai: true },
        { name: 'houdry-hp', url: 'https://192.168.29.48:18080', api: 'https://192.168.29.48:18080/v1', auth: false, openai: true }
      ],
      ifaces
    )

    assert.equal(out.length, 1)
    assert.equal(out[0].url, 'https://192.168.29.48:18080')
  })

  it('collapses one instance advertised on WiFi and WSL to the WiFi URL', () => {
    const out = uniqueFabricEndpoints(
      [
        { name: 'houdry-Lethal_laptop-8090', url: 'https://172.23.96.1:8090', api: 'https://172.23.96.1:8090/v1', auth: false, openai: true },
        { name: 'houdry-Lethal_laptop-8090', url: 'https://192.168.29.179:8090', api: 'https://192.168.29.179:8090/v1', auth: false, openai: true }
      ],
      ifaces
    )

    assert.equal(out.length, 1)
    assert.equal(out[0].url, 'https://192.168.29.179:8090')
  })

  it('keeps this machine\'s WiFi address instead of rewriting to 127.0.0.1', () => {
    const wslAndWifi = {
      'vEthernet (WSL)': [{ address: '172.23.96.1', netmask: '255.255.240.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
      'Wi-Fi': [{ address: '172.24.110.66', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }]
    }

    const out = uniqueFabricEndpoints(
      [
        { name: 'houdry-Lethal_laptop-8090', url: 'https://172.23.96.1:8090', api: 'https://172.23.96.1:8090/v1', auth: false, openai: true },
        { name: 'houdry-Lethal_laptop-8090', url: 'https://172.24.110.66:8090', api: 'https://172.24.110.66:8090/v1', auth: false, openai: true }
      ],
      wslAndWifi
    )

    assert.equal(out.length, 1)
    assert.equal(out[0].url, 'https://172.24.110.66:8090')
    assert.equal(out[0].api, 'https://172.24.110.66:8090/v1')
  })

  it('upgrades an http advertisement before deduping, so one plane is one entry', () => {
    const out = uniqueFabricEndpoints(
      [
        { name: 'plane', url: 'http://10.0.0.9:18080', api: 'http://10.0.0.9:18080/v1', auth: false, openai: true },
        { name: 'plane', url: 'https://10.0.0.9:18080', api: 'https://10.0.0.9:18080/v1', auth: false, openai: true }
      ],
      ifaces
    )

    assert.equal(out.length, 1)
    assert.equal(out[0].api, 'https://10.0.0.9:18080/v1')
  })

  it('scores a link-local address below a routable one', () => {
    assert.ok(lanAddressScore('https://169.254.8.9:18080') < lanAddressScore('https://10.5.0.7:18080'))
  })
})

describe('ipv4IsAssignedToThisHost and preferLoopbackIfLocal', () => {
  const ifaces = { 'Wi-Fi': [{ address: '192.168.29.179', family: 'IPv4', netmask: '255.255.255.0', mac: '', internal: false, cidr: null }] }

  it('rewrites an address owned by this machine to loopback', () => {
    const ep = preferLoopbackIfLocal({ url: 'https://192.168.29.179:18080', api: 'https://192.168.29.179:18080/v1' }, ifaces)

    assert.equal(ep.url, 'https://127.0.0.1:18080')
    assert.equal(ep.api, 'https://127.0.0.1:18080/v1')
  })

  it('leaves a peer\'s address alone', () => {
    const ep = preferLoopbackIfLocal({ url: 'https://192.168.29.48:18080', api: 'https://192.168.29.48:18080/v1' }, ifaces)

    assert.equal(ep.url, 'https://192.168.29.48:18080')
    assert.equal(ipv4IsAssignedToThisHost('192.168.29.48', ifaces), false)
    assert.equal(ipv4IsAssignedToThisHost('192.168.29.179', ifaces), true)
  })
})

describe('ipv4Broadcast', () => {
  it('computes a directed broadcast', () => {
    assert.equal(ipv4Broadcast('192.168.1.40', '255.255.255.0'), '192.168.1.255')
    assert.equal(ipv4Broadcast('10.0.0.5', '255.255.0.0'), '10.0.255.255')
  })

  it('rejects garbage', () => {
    assert.equal(ipv4Broadcast('::1', '255.255.255.0'), null)
    assert.equal(ipv4Broadcast('192.168.1.1', 'ffff'), null)
  })
})

describe('udpBroadcastTargets', () => {
  it('always includes limited broadcast and the houdry multicast group', () => {
    assert.deepEqual(udpBroadcastTargets({}), ['255.255.255.255', '239.255.77.77'])
  })

  it('adds per-interface directed broadcasts and skips loopback', () => {
    const targets = udpBroadcastTargets({
      Loopback: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
      'Wi-Fi': [{ address: '192.168.1.40', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }]
    })

    assert.ok(targets.includes('192.168.1.255'))
    assert.ok(!targets.includes('127.255.255.255'))
  })

  it('does not probe Hyper-V/WSL virtual adapters', () => {
    const targets = udpBroadcastTargets({
      'vEthernet (WSL)': [{ address: '172.23.96.1', netmask: '255.255.240.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
      'Wi-Fi': [{ address: '192.168.29.179', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }]
    })

    assert.ok(targets.includes('192.168.29.255'))
    assert.ok(!targets.includes('172.23.111.255'))
  })
})

describe('endpointsFromMDNSAnswer', () => {
  it('turns a DNS-SD answer into a plane address', () => {
    const [ep] = endpointsFromMDNSAnswer(houdryMDNSAnswer({ instance: 'houdry-lab', address: '192.168.29.48', port: 18080 }))

    assert.deepEqual(ep, {
      name: 'houdry-lab',
      url: 'https://192.168.29.48:18080',
      api: 'https://192.168.29.48:18080/v1',
      version: '0.6.16',
      auth: true,
      openai: true,
      source: 'mdns',
      target: 'houdry-lab.local'
    })
  })

  it('reads auth and openai out of the TXT records', () => {
    const [ep] = endpointsFromMDNSAnswer(houdryMDNSAnswer({ txt: { auth: '0', openai: '0' } }))

    assert.equal(ep.auth, false)
    assert.equal(ep.openai, false)
  })

  it('drops a service instance with no address record', () => {
    // PTR + SRV + TXT, no A: nothing to connect to.
    const question = dnsQuestion(dnsName('_houdry._tcp.local'), TYPE_PTR)
    const instanceName = dnsName('houdry-lab._houdry._tcp.local')
    const packet = Buffer.concat([
      dnsHeader({ qd: 1, an: 2 }),
      question,
      dnsRecord(instanceName, 33, Buffer.concat([Buffer.alloc(6), dnsName('gone.local')])),
      dnsRecord(instanceName, 16, Buffer.from([4]))
    ])

    assert.deepEqual(endpointsFromMDNSAnswer(packet), [])
  })

  it('ignores answers for some other service type', () => {
    const question = dnsQuestion(dnsName('_printer._tcp.local'), TYPE_PTR)
    const instanceName = dnsName('deskjet._printer._tcp.local')
    const packet = Buffer.concat([
      dnsHeader({ qd: 1, an: 1, ar: 1 }),
      question,
      dnsRecord(instanceName, 33, Buffer.concat([Buffer.alloc(6), dnsName('deskjet.local')])),
      dnsRecord(dnsName('deskjet.local'), 1, Buffer.from([10, 0, 0, 5]))
    ])

    assert.deepEqual(endpointsFromMDNSAnswer(packet), [])
  })

  it('survives a truncated or junk packet', () => {
    assert.deepEqual(endpointsFromMDNSAnswer(Buffer.alloc(4)), [])
    assert.deepEqual(endpointsFromMDNSAnswer(Buffer.from('not dns at all')), [])
  })
})

describe('listenForAdvertise', () => {
  it('answers with whatever replied, and never throws when nothing did', async () => {
    const found = await listenForAdvertise(200)

    assert.ok(Array.isArray(found))
  })
})

describe('mdnsQueryPacket', () => {
  it('asks exactly one PTR question for the houdry service type', () => {
    const packet = mdnsQueryPacket()
    const name = dnsName('_houdry._tcp.local')

    assert.equal(packet.readUInt16BE(2), 0) // flags: a query, not a response
    assert.equal(packet.readUInt16BE(4), 1) // QDCOUNT
    assert.equal(packet.subarray(12, 12 + name.length).toString('hex'), name.toString('hex'))
    assert.equal(packet.readUInt16BE(12 + name.length), TYPE_PTR)
    assert.equal(packet.readUInt16BE(12 + name.length + 2), 1) // class IN
    assert.equal(packet.length, 12 + name.length + 4)
  })
})

describe('discoverHoudryFabric', () => {
  it('answers with the planes that replied, over both transports', async () => {
    const found = await discoverHoudryFabric(200)

    assert.ok(Array.isArray(found))

    for (const ep of found) {
      assert.match(ep.api, /^https:\/\//)
      assert.ok(['udp', 'mdns'].includes(ep.source))
    }
  })
})
