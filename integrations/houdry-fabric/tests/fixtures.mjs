// Fixtures for the Houdry fabric integration tests.
//
// Two throwaway self-signed roots with CA:TRUE. They exist so the pin and
// rotation paths can be exercised against real DER, and they trust nothing:
// nothing in this repo should ever point HOUDRY_FABRIC_CA at them.

export const ROOT_A = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUAgyFKDOVrrQ6u8CobDk+X6ELQNIwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZaG91ZHJ5LWZhYnJpYy10ZXN0LXJvb3QtYzAgFw0yNjEw
MTUxNDI2MTFaGA8yMTI2MDkyMTE0MjYxMVowJDEiMCAGA1UEAwwZaG91ZHJ5LWZh
YnJpYy10ZXN0LXJvb3QtYzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
APvK4ZfnocjSgCPlUBeuf6mZMb3EtA0durlpc119vX5rio04YUL8SgyJ1DPGkTYd
MAWmDpK9hRvRUg9yOp0OaHkACQyhQLrBVzJsBxUy+RhIDRZ6Cx3m+ODP4cfFO+Bt
AFOad2IbUUm78G5Kd2qxb5BnAS1fpe8POCuvflxKAKS8MBk1Ca3B1XElvoED9lWf
hE3RkhyzY3GT6q+++vDY2HBfUOLJme8hDJPB08T9tmPxwPuf7iaCMYbkhQEWA6fZ
8Wn6CKB+37NmvHLpjgFr0kMYIjiGpunbpfxv1UJulrFoDcAPqCL5TmZfTgWXpbvs
GcmIoEM+qznW2JSE7DlUrr8CAwEAAaNTMFEwHQYDVR0OBBYEFCz/HYrpI0WW47FO
/mSDEPNI2QvLMB8GA1UdIwQYMBaAFCz/HYrpI0WW47FO/mSDEPNI2QvLMA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAGaFVL5FO1DRzKBpObL/XyVG
DWB26H3HU+fWIlP3doU3HBq8KVNC2M2m5mx5jhiJ3ZXadyjkql8nfs4TgHDWoHam
ZPWX14ztf6BTiMr5KWdr2g+PUi7iVZ97WWfymGE0ogyTxMEaV0O4V3A3I8sBQUrN
0G7ogzoGbxdoa1UNjyicEJ3fjOeHp+NLIQcHJwaZyy3S9k+UpbuZbv+1n/1v+6l1
s7tVfj6gTcDcpF4BRj3A33X6rUMPzM1B/BqTAnXsuXwoT2foQvUq8vneht4MJp1m
KjGh/slKWizfXTgLfqjZqSIuFZK/bHOLyiKXRDtY4Qgv11gLYerzg/I/tryW9mk=
-----END CERTIFICATE-----
`

export const ROOT_B = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUNxqJIJY0cSLDL6HYuS2ilM8VQeYwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZaG91ZHJ5LWZhYnJpYy10ZXN0LXJvb3QtZDAgFw0yNjEw
MTUxNDI2MTJaGA8yMTI2MDkyMTE0MjYxMlowJDEiMCAGA1UEAwwZaG91ZHJ5LWZh
YnJpYy10ZXN0LXJvb3QtZDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AJkiZJWun1SRCzsqyuRPDbBO5p3B9PfQOAQmFTygnqKYi/MpSyrqFGrWrGzyxDIs
VNbXxOsnOqR9ZiEj3+ZHFVNIPXfFufJCYqiA9q8AeIEHA2Ov/polMpErFqXuKT9Q
4OPT3uzbfTNcMajBfraCR3z5Ma4r5cf4+BiRbAR2AZVdWLMFuWo67ZKUObT87NLT
YpLaMWT+GdN7+7EMcCtsAWi2szB2dD9Db5ukmhcAIIxXsrSQyCTYOjnSuaOmsEgY
/AOUzosO/lywQMJGnBSwxW7TWGlWD/4gFzCgq7zIMVAi+4toxvdsUQXLquzHQRzC
ZXMqMSH366RpebVFmms1pi8CAwEAAaNTMFEwHQYDVR0OBBYEFI8TInqh4MawCjsl
iwhWCKfu+QLrMB8GA1UdIwQYMBaAFI8TInqh4MawCjsliwhWCKfu+QLrMA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAHJy/Hwt1Nvsv3PnKasacJw9
8ZPb4b7UtSUq7018hU4hEo3WQiBtohSfJQwm8sutnGjIR6dJ0HsUc/5pA4DMwyhV
IgGoqwaMbfsmdrFXO9j1hTKyQxnO1yZCsZM+0yRuVQT9awJ/bU+1NrnkyTChWBeE
Wr/6HEd11kl/f5Ohn+m1k5ty7aFJNgF2dGt68rhZMCiSMMwETM1Irh9qL0SVYDwQ
w0lbIVHPNQd8SWGJEK55QsFObAYafyVifgIyY/PK3jUl2g2waBUvVzIXluGtKzbI
XruYYXizj87KSOcL2XxjhHnmKJRUpKNc0Pk5plIZlb2RMJJYGHrsL6v4i4nSBQg=
-----END CERTIFICATE-----
`

/** Build one DNS label sequence: `a.b` → 01 61 01 62 00. */
export function dnsName(name) {
  const parts = name.split('.').filter(Boolean)
  const buffers = parts.map(label => {
    const bytes = Buffer.from(label, 'utf8')
    const head = Buffer.alloc(1)

    head.writeUInt8(bytes.length, 0)

    return Buffer.concat([head, bytes])
  })

  return Buffer.concat([...buffers, Buffer.alloc(1)])
}

/** A name-compression pointer to an earlier offset in the same packet. */
export function dnsPointer(offset) {
  const buf = Buffer.alloc(2)

  buf.writeUInt16BE(0xc000 | offset, 0)

  return buf
}

export function dnsRecord(name, type, rdata) {
  const head = Buffer.alloc(10)

  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(1, 2) // class IN
  head.writeUInt32BE(120, 4) // TTL
  head.writeUInt16BE(rdata.length, 8)

  return Buffer.concat([name, head, rdata])
}

export function dnsQuestion(name, type) {
  return Buffer.concat([name, uint16(type), uint16(1)])
}

function uint16(value) {
  const buf = Buffer.alloc(2)

  buf.writeUInt16BE(value, 0)

  return buf
}

export function dnsHeader(counts) {
  const head = Buffer.alloc(12)

  head.writeUInt16BE(0, 0) // transaction id
  head.writeUInt16BE(0x8400, 2) // response, authoritative
  head.writeUInt16BE(counts.qd ?? 0, 4)
  head.writeUInt16BE(counts.an ?? 0, 6)
  head.writeUInt16BE(counts.ns ?? 0, 8)
  head.writeUInt16BE(counts.ar ?? 0, 10)

  return head
}

/** One TXT rdata is a sequence of length-prefixed strings, like the fabric writes. */
export function dnsTXT(fields) {
  return Buffer.concat(
    Object.entries(fields).map(([key, value]) => {
      const text = Buffer.from(`${key}=${value}`, 'utf8')
      const head = Buffer.alloc(1)

      head.writeUInt8(text.length, 0)

      return Buffer.concat([head, text])
    })
  )
}

export function dnsSRV({ port, target }) {
  const head = Buffer.alloc(6)

  head.writeUInt16BE(0, 0) // priority
  head.writeUInt16BE(0, 2) // weight
  head.writeUInt16BE(port, 4)

  return Buffer.concat([head, target])
}

export function dnsIPv4(address) {
  return Buffer.from(address.split('.').map(Number))
}

export const TYPE_A = 1
export const TYPE_PTR = 12
export const TYPE_TXT = 16
export const TYPE_SRV = 33

/**
 * A DNS-SD answer of the shape `zeroconf.Register(info.Name, "_houdry._tcp",
 * "local.", port, txtRecords(info))` produces: PTR for the service type, the
 * instance's SRV/TXT, and an A for the SRV target in the additionals — with
 * names compressed, because that is what a real responder sends.
 */
export function houdryMDNSAnswer({ instance = 'houdry-lab', host = 'houdry-lab', address = '192.168.29.48', port = 18080, txt = {} } = {}) {
  const service = '_houdry._tcp.local'
  const questionOffset = 12
  const question = dnsQuestion(dnsName(service), TYPE_PTR)
  const instanceName = dnsName(`${instance}.${service}`)
  const hostName = dnsName(`${host}.local`)

  // The PTR record is 2 (compressed name) + 10 (fixed fields) + 2 (compressed
  // rdata) bytes, so the instance name it points at starts right after it.
  const instanceOffset = questionOffset + question.length + 14

  const answers = Buffer.concat([
    dnsRecord(dnsPointer(questionOffset), TYPE_PTR, dnsPointer(instanceOffset)),
    dnsRecord(instanceName, TYPE_SRV, dnsSRV({ port, target: hostName })),
    dnsRecord(instanceName, TYPE_TXT, dnsTXT({ txtvers: '1', path: '/v1', version: '0.6.16', auth: '1', openai: '1', ...txt }))
  ])

  const additionals = dnsRecord(hostName, TYPE_A, dnsIPv4(address))

  return Buffer.concat([dnsHeader({ qd: 1, an: 3, ar: 1 }), question, answers, additionals])
}
