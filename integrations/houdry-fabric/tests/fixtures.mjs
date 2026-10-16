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

// Throwaway signing material for the loopback plane simulator in watch.test.mjs,
// generated for these tests alone and trusted by nothing outside them: the root
// signs only the leaf, and the leaf names 127.0.0.1 and localhost.
export const SIMULATOR_ROOT = "-----BEGIN CERTIFICATE-----\r\nMIIDGDCCAgCgAwIBAgIUcHVK/oz9CbOxIP3lkI8v2WDnsAYwDQYJKoZIhvcNAQEL\r\nBQAwJDEiMCAGA1UEAwwZaG91ZHJ5LWZhYnJpYy10ZXN0LXJvb3QtZTAeFw0yNjEw\r\nMTYwNDUwMTlaFw0zNjEwMTMwNDUwMTlaMCQxIjAgBgNVBAMMGWhvdWRyeS1mYWJy\r\naWMtdGVzdC1yb290LWUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCf\r\nKlcgHX6szHqZWgg2nQND78MlSAMHeS0XeyDWLWsE1atZDIH256FXU7nokS7BVplk\r\nfv6Rby6iu8obN4aPm3W2xkbigiSzucor5fV3LRS1J2AZMyVAoJKH124j/r1RM0/d\r\nFPZKX9GxRKZ+bKRC8jAR9/nuJwZBk+bR3fBvYN4nJ2ppwNpk1AXEvK85W/6JDKjR\r\nA5Lcbot6Bwel2rAVR9AJiTO3PlU3LXK2dswRWmAkgxI3sRNRiSeI7hzSISoQvCuo\r\n/lmruECeSydKlaGaF0QIP8BonK5/Du+9/jBmfn5eW86DRunDSGIS3A8FB9MYTNI9\r\nDd5Q3Szzu9vKXrnVNIzVAgMBAAGjQjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0P\r\nAQH/BAQDAgIEMB0GA1UdDgQWBBS4Lb+nuPJCpPyD/40He9Wv7jnIxDANBgkqhkiG\r\n9w0BAQsFAAOCAQEAf1ivmd+WUK8t3aF+7VnhUq/xHCfVWOUL+O1IOTWaDZrfRIEK\r\nGrguKsgLCl+URdHb5+HBJ2O342CKTHeaQjGtc/n7Nxm0jVtQln+8u/XTb9ntFcL2\r\nOAljZE0uc76qee1dkJDdYwNEzeLgdIE2T2/wQFDezGdaPWurepe5jPFGxDHIooKZ\r\nr1fhvu4ABkNKh1T1kHFeq0mBYEmQ5lHG81EnMV8zobKUUN3c+nPt745oWuy3iDKU\r\nA7N/k6NgvpazA+4eQ0lQ+GZIYF81lFAUJZLIjsL3ZxPclsiqwUnsRJ05/ZXoAopD\r\noBr07QuT4DsE1KpQWua6rWiqWNTy1hSVNbAmNQ==\r\n-----END CERTIFICATE-----\n"
export const SIMULATOR_LEAF = "-----BEGIN CERTIFICATE-----\r\nMIIDYzCCAkugAwIBAgIUbMlUoiMBiaNWAi2hs3RoFlcQDZkwDQYJKoZIhvcNAQEL\r\nBQAwJDEiMCAGA1UEAwwZaG91ZHJ5LWZhYnJpYy10ZXN0LXJvb3QtZTAeFw0yNjEw\r\nMTYwNDUwMTlaFw0zNjEwMTMwNDUwMTlaMCQxIjAgBgNVBAMMGWhvdWRyeS1mYWJy\r\naWMtdGVzdC1sZWFmLWUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCi\r\nTKGI9rX6uz86/wXaf2ge1s8h6rTGkAubveLDYt7GntbOjdg38Vaq24o2nk3r5Jir\r\nTzwSl59NqfEBhaHgPDSc6+mwpptF0IuKutMpmMb4GeD1pQUbfJ9/DEpYniE0Cuak\r\nmMdqbo8cDT8sgKePWcACehbhdWVskBsKZaaY8fdPBx6BiaKTbu6khTBbrJ3L3peh\r\n+CfK9sp5JiL8GI/4KIh3D0uxWX7ZRwz2z+IIdRcxmBu1+iwMBpS35KjZHN+/mFLv\r\nVBdVpVHYXBGo2mTmGbHf7Z+jXq6L1DNCBBimM3CmVPyXtEOurj5sVvf1s0YcZZ58\r\nQvx8+JNi9yLHFK6HFcD/AgMBAAGjgYwwgYkwCQYDVR0TBAIwADALBgNVHQ8EBAMC\r\nBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwGgYDVR0RBBMwEYcEfwAAAYIJbG9jYWxo\r\nb3N0MB0GA1UdDgQWBBRzDoTR8TRCid6rQLSdl+un009brTAfBgNVHSMEGDAWgBS4\r\nLb+nuPJCpPyD/40He9Wv7jnIxDANBgkqhkiG9w0BAQsFAAOCAQEAkPdjEjwsaTd1\r\nyHleDqleJF03i9Sk5aFfPbRWf75uYQXX2ot9IRdNbF9LitH72E7YA51c6po+lBf5\r\nW5zGXrKtJSmajAuSYKkAakv8EQn9CaaInZlcpkdf/IJOAqbimsNcVyge0oKCTROW\r\nanpo0at4JijkN4xzBG96tVoPfrdA3hn6Y2L5zF4IP2SOBlxL0ysVrqGzL98RG8Id\r\nl5omT5NFO5YDG1i0ftBQ+lCY9bnPqlwCbnYNoiFoZf4tQ9q5o4H+axbPtJxqncMR\r\nDkAFj8zXQzKk2jKSJqXLc40WbW9DN942shG6M489usC5jTpCET+rd8JOsmT+It6C\r\nfjMMPpgrLg==\r\n-----END CERTIFICATE-----\n"
export const SIMULATOR_LEAF_KEY = "-----BEGIN PRIVATE KEY-----\r\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCiTKGI9rX6uz86\r\n/wXaf2ge1s8h6rTGkAubveLDYt7GntbOjdg38Vaq24o2nk3r5JirTzwSl59NqfEB\r\nhaHgPDSc6+mwpptF0IuKutMpmMb4GeD1pQUbfJ9/DEpYniE0CuakmMdqbo8cDT8s\r\ngKePWcACehbhdWVskBsKZaaY8fdPBx6BiaKTbu6khTBbrJ3L3peh+CfK9sp5JiL8\r\nGI/4KIh3D0uxWX7ZRwz2z+IIdRcxmBu1+iwMBpS35KjZHN+/mFLvVBdVpVHYXBGo\r\n2mTmGbHf7Z+jXq6L1DNCBBimM3CmVPyXtEOurj5sVvf1s0YcZZ58Qvx8+JNi9yLH\r\nFK6HFcD/AgMBAAECggEAIlRwRL7evmL2HH4OGGojtYY9eRCi3W9hrTdMrISQ19WI\r\nXVeemTK44NogUa5JkDCh5HaVn98niK9+NZK1K2/At0Klg0KyjGFw6s7a1K0mxRsA\r\nPSWDP42sVRzd6wHDxzTZFY7le4tYRRg+OSUbjFRxK3T0uwrwgba3qYrX4vknlTT3\r\nMbgfkZBzz5z/h1P444mTGJ9Ad8uq/YHet8UxJZmgn4WfWQpXk0ip3SBaOh/soSZS\r\n0du0WrvJLSdGvP2b59oSMOF5VPtpsTryKc0bmQZYEKp0pyRMlmSDn5XRJQJJhQA2\r\n8HdgsrCTJ4dR7HH7FGnnQCtMdrLWWGVxTG85u6Pu1QKBgQDfq7q/4dlpdrqMV453\r\n3yY/i6hm5aihcU/8iOqUqUOSKMWWRFDVslaZhzjlMJO1T7jrfLK1h4wqXS21J6bL\r\nrm2SIoJe4JSf42QqUs0funZTxJ9IvQgr/IZFLH5JvzcXa6Gg0YWDdcXE+7idhwsM\r\nnvEMiFy7T84dZ/aQzVrCzIfDRQKBgQC5wgiEF7KLJtn5mITulCJXu47Oxdp1bPu8\r\nXPcizcuOeMtshin94HSItr+sYfJgaa3+HCWZgSknFs/ibkfih6JAu1GQcvuvhEB/\r\n7zHDVcyx/kQhaHU5y8EqEpQKxprel+GXih8uGagg8ZfajVBzNfzv8ukYmFWEHNs3\r\niQMOftj1cwKBgBNt+ooCl31G2Auq63BUTSFGA3n0x0JG8pjQV/hT/8+phQh5pL/7\r\nfvRVP8cBAkPEyh6CtY95V96yO286I44b996y6rpNLfv5p9DZYoI4E2FReji6WwRf\r\nKlbF9652UtXQ/rhWmw+BYo2rBC2C9p3BDNV23v9SfmgliNCpVhIH7F81AoGAF+Tb\r\nj5I0xy1yMGbsAnxPhpV7oyFUHnKsVuhmabWrD2J+WDFRyXRLySIouZXHxZsSZHNe\r\nasZwcrS+fNPOr1bfChCOR1RjB4qteUddUVECCYs5XErBeXO6Hx1QqaouVZ+XxxRf\r\nOmDWfZZWACjZRliVdo/6Z82AgoPrttMK75xlb/0CgYEAzcYImANiWSm7EEAa2ASB\r\nGfzRwnr35CdMvOoWBRze0XjV6/Rpsp/oSgn1nn2YpQttMtU8UY9uvwULowXPorsB\r\nXVl1PUg07emmJQZ5BM9ZxucXcihz7QuEIw+AfLDD5SOXk0c1hcWvLduwdp47+95P\r\nAwSXEbHvBr/+LV42gF3R0m4=\r\n-----END PRIVATE KEY-----\n"
