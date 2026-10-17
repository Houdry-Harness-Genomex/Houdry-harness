import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer, type Server } from 'node:https'
import type { Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { caFetchFor, internals, transportFailureDetail } from '../src/ca-fetch.ts'
import * as LlmPiAi from '../src/index.ts'
import {
  TEST_LEAF,
  TEST_LEAF_KEY,
  TEST_LEAF_TWO,
  TEST_LEAF_TWO_KEY,
  TEST_ROOT,
  TEST_ROOT_TWO,
} from './fixtures/ca-test-certs.ts'

// Throwaway self-signed material generated for these tests alone; trusted by
// nothing outside them. The roots sign only their leaves, and the leaves name
// 127.0.0.1 and localhost.

let dir: string
let caPath: string
let server: Server
let origin: string

function listen(target: NetServer): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', () => {
      resolve(target.address() as AddressInfo)
    })
  })
}

function close(target: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    target.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

beforeAll(async () => {
  server = createServer({ cert: TEST_LEAF, key: TEST_LEAF_KEY }, (request, response) => {
    if (request.url?.endsWith('/chat/completions') === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (payload: object): void => { response.write(`data: ${JSON.stringify(payload)}\n\n`) }
      chunk({
        id: 'chatcmpl-ca-fetch-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }],
      })
      chunk({
        id: 'chatcmpl-ca-fetch-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  const address = await listen(server)
  origin = `https://127.0.0.1:${String(address.port)}`
  dir = await mkdtemp(join(tmpdir(), 'houdry-ca-fetch-'))
})
afterAll(async () => {
  await close(server)
  await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  caPath = join(dir, 'ca.pem')
  await writeFile(caPath, TEST_ROOT)
})

describe('caFetchFor', () => {
  it('verifies a request against the route CA file and accepts every fetch input shape', async () => {
    expect(transportFailureDetail(origin)).toBeUndefined()
    const fetch = caFetchFor(caPath)
    expect((await fetch(`${origin}/v1/models`)).status).toBe(200)
    // The second request reuses the built dispatcher; the input arrives as a URL.
    expect((await fetch(new URL(`${origin}/v1/models`))).status).toBe(200)
    // The Request form is reduced to its URL so the origin key stays the dialed one.
    expect((await fetch(new Request(`${origin}/v1/models`))).status).toBe(200)
    expect(await (await fetch(`${origin}/v1/models`)).text()).toBe('{"ok":true}')
    expect(transportFailureDetail(origin)).toBeUndefined()
  })

  it('rejects a certificate the route CA does not vouch for and records the cause', async () => {
    await writeFile(caPath, TEST_ROOT_TWO)
    const fetch = caFetchFor(caPath)
    await expect(fetch(`${origin}/v1/models`)).rejects.toThrow()
    expect(transportFailureDetail(origin)).toMatch(/cert/i)
  })

  it('fails a request whose CA file cannot be read and names the file it tried', async () => {
    const fetch = caFetchFor(join(dir, 'absent-ca.pem'))
    await expect(fetch(`${origin}/v1/models`)).rejects.toThrow('could not be read')
    expect(transportFailureDetail(origin)).toContain('could not be read')
  })

  it('bounds its dispatcher cache, evicting the oldest CA bundle', async () => {
    // Distinct bundles of the same root: each variant is a valid CA file, and
    // each gets its own cache entry until the ninth pushes the first out.
    for (let index = 0; index < 9; index += 1) {
      const variant = join(dir, `ca-${String(index)}.pem`)
      await writeFile(variant, TEST_ROOT.repeat(index + 1))
      const fetch = caFetchFor(variant)
      expect((await fetch(`${origin}/v1/models`)).status).toBe(200)
    }
  })

  it('bounds its failure records, evicting the oldest origin', async () => {
    const fetch = caFetchFor(caPath)
    for (let index = 0; index < 33; index += 1) {
      await fetch(`https://houdry-failure-probe-${String(index)}.invalid/v1/models`).catch(() => undefined)
    }
    expect(transportFailureDetail('https://houdry-failure-probe-0.invalid')).toBeUndefined()
    expect(transportFailureDetail('https://houdry-failure-probe-32.invalid')).toBeDefined()
  }, 30_000)

  it('tunnels through the installed proxy policy while verifying against the route CA', async () => {
    // A proxy that refuses every tunnel: the CONNECT line is the assertion,
    // and the target host never has to resolve.
    const refusedTunnels: string[] = []
    const proxy = createHttpServer()
    proxy.on('connect', (request, socket) => {
      refusedTunnels.push(request.url ?? '')
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.end()
    })
    const proxyAddress = await listen(proxy)
    const dispose = await installProxyFromEnvironment(
      { get: name => name === 'HTTPS_PROXY' ? { value: `http://127.0.0.1:${String(proxyAddress.port)}` } : undefined },
      () => undefined,
    )
    try {
      const fetch = caFetchFor(caPath)
      const target = 'https://houdry-tls-probe.invalid/v1/models'
      await expect(fetch(target)).rejects.toThrow()
      expect(refusedTunnels).toContain('houdry-tls-probe.invalid:443')
      expect(transportFailureDetail('https://houdry-tls-probe.invalid')).toBeDefined()
    } finally {
      await dispose()
      await close(proxy)
    }
  })

  it('re-reads the CA file per request, so a rotated plane is trusted without a route change', async () => {
    const fetch = caFetchFor(caPath)
    expect((await fetch(`${origin}/v1/models`)).status).toBe(200)
    // The plane now serves a leaf the first root does not vouch for; dropping
    // the pooled sockets forces the fresh handshake the rotation implies.
    server.setSecureContext({ cert: TEST_LEAF_TWO, key: TEST_LEAF_TWO_KEY })
    server.closeIdleConnections()
    try {
      await expect(fetch(`${origin}/v1/models`)).rejects.toThrow()
      // Overwriting the route's CA file — what an explicit repin writes — is
      // enough; the same fetch closure picks the new root up on the next read.
      await writeFile(caPath, TEST_ROOT_TWO)
      expect((await fetch(`${origin}/v1/models`)).status).toBe(200)
    } finally {
      server.setSecureContext({ cert: TEST_LEAF, key: TEST_LEAF_KEY })
      server.closeIdleConnections()
    }
  })

  it('carries a real chat completion through the shipping adapter over the route CA', async () => {
    vi.stubEnv('PI_TEST_KEY', 'probe-key')
    try {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, {
        providers: {
          houdry: {
            api: 'openai-completions',
            baseURL: `${origin}/v1`,
            apiKeyEnv: 'PI_TEST_KEY',
            caFile: caPath,
            models: [{ id: 'test-model' }],
          },
        },
      })
      const chunks: unknown[] = []
      for await (const chunk of ctx.llm.stream({ provider: 'houdry', model: 'test-model', messages: [] })) {
        chunks.push(chunk)
      }
      const text = chunks
        .filter((chunk): chunk is { type: 'text-delta'; text: string } => (chunk as { type: string }).type === 'text-delta')
        .map(chunk => chunk.text)
        .join('')
      expect(text).toBe('hi')
      expect((chunks.at(-1) as { reason?: { kind?: string } }).reason?.kind).toBe('stop')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reports a transport-failing route as a connection error carrying the recorded cause', async () => {
    vi.stubEnv('PI_TEST_KEY', 'probe-key')
    try {
      // The route's CA does not vouch for the endpoint; the request fails and
      // the SDK's generic message arrives enriched with the real certificate
      // failure instead of a bare "Connection error.".
      await writeFile(caPath, TEST_ROOT_TWO)
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, {
        providers: {
          houdry: {
            api: 'openai-completions',
            baseURL: `${origin}/v1`,
            apiKeyEnv: 'PI_TEST_KEY',
            caFile: caPath,
            models: [{ id: 'test-model' }],
          },
        },
      })
      const chunks: unknown[] = []
      for await (const chunk of ctx.llm.stream({ provider: 'houdry', model: 'test-model', messages: [] })) {
        chunks.push(chunk)
      }
      const finish = chunks.at(-1) as { reason?: { kind?: string; failure?: { message?: string; code?: string } } }
      expect(finish.reason?.kind).toBe('error')
      expect(finish.reason?.failure?.message).toContain('Connection error. (unable to verify the first certificate')
      expect(finish.reason?.failure?.code).toBe('TRANSPORT')
    } finally {
      vi.unstubAllEnvs()
    }
  }, 30_000)
})

describe('cause-chain flattening', () => {
  const describeCause = internals.describeCause

  it('joins aggregate children into one line', () => {
    expect(describeCause(new AggregateError([new Error('first attempt'), Object.assign(new Error('socket hung up'), { code: 'ECONNRESET' })])))
      .toBe('first attempt | socket hung up [ECONNRESET]')
  })

  it('skips the generic fetch-failed wrappers straight to their cause', () => {
    expect(describeCause(new TypeError('fetch failed', { cause: new Error('connection refused') }))).toBe('connection refused')
    expect(describeCause(new TypeError('', { cause: new Error('connection refused') }))).toBe('connection refused')
  })

  it('keeps a non-generic wrapper and its cause', () => {
    expect(describeCause(new Error('handshake failed', { cause: new Error('certificate unknown') }))).toBe('handshake failed; certificate unknown')
  })

  it('appends an errno code the message lacks and keeps one it already carries', () => {
    expect(describeCause(Object.assign(new Error('socket gone'), { code: 'ECONNRESET' }))).toBe('socket gone [ECONNRESET]')
    expect(describeCause(Object.assign(new Error('ECONNRESET socket'), { code: 'ECONNRESET' }))).toBe('ECONNRESET socket')
  })

  it('stringifies non-errors and caps runaway chains', () => {
    expect(describeCause('plain string')).toBe('plain string')
    expect(describeCause(new Error('deep'), 6)).toBe('…')
  })
})
