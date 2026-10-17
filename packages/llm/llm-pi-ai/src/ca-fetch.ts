/**
 * Per-request fetch for provider routes that name a `caFile`.
 *
 * `NODE_EXTRA_CA_CERTS` is read once at Node start, so a route adopted
 * mid-flight (the fabric watcher writes its route after boot) cannot rely on
 * it. This module instead builds each request's undici dispatcher with the
 * route's own CA chain, read from disk per request so the plane can rotate
 * its certificate without a configuration change. Verification stays on: the
 * CA adds trust, it never relaxes it — `rejectUnauthorized` is never touched.
 *
 * The OpenAI SDK collapses any fetch rejection into `APIConnectionError`
 * ("Connection error.") and pi-ai flattens that to its message, so the
 * actionable transport detail would be lost. The wrapper therefore records
 * the unwrapped cause chain per origin before rethrowing; the stream layer
 * reads it back through {@link transportFailureDetail} to name the real
 * reason. Details are Node error text only — never headers, URLs with
 * credentials, or keys.
 *
 * @module dsh-llm-pi-ai/ca-fetch
 */

import { readFile } from 'node:fs/promises'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'

/** Dispatchers built so far, keyed by CA content + proxy route; bounded, evicted FIFO. */
const dispatchers = new Map<string, Dispatcher>()
const DISPATCHER_LIMIT = 8

/** Most recent transport failure detail per request origin, oldest entries evicted. */
const recentFailures = new Map<string, string>()
const FAILURE_LIMIT = 32

/**
 * The recorded transport failure detail for one origin, for the stream layer
 * to surface when only the SDK's generic "Connection error." survives. The
 * last failure is kept rather than cleared by a later success: a stream that
 * reports a connection error without a fresh record would then lose the only
 * diagnostic for it.
 * @param origin - the route endpoint's origin.
 * @returns the most recent failure's detail for this origin, or undefined when no request to it has failed.
 */
export function transportFailureDetail(origin: string): string | undefined {
  return recentFailures.get(origin)
}

function recordFailure(origin: string, detail: string): void {
  recentFailures.delete(origin)
  recentFailures.set(origin, detail)
  if (recentFailures.size > FAILURE_LIMIT) {
    recentFailures.delete(recentFailures.keys().next().value as string)
  }
}

/**
 * Flatten an error and its `cause` chain into one readable line. undici hands
 * a rejected fetch a bare `TypeError: fetch failed` and carries everything
 * actionable (certificate codes, ECONNREFUSED, DNS) on the chain behind it.
 */
function describeCause(error: unknown, depth = 0): string {
  if (depth > 5) return '…'
  if (error instanceof AggregateError) {
    return error.errors.map(inner => describeCause(inner, depth + 1)).join(' | ')
  }
  if (!(error instanceof Error)) return String(error)
  const code = (error as NodeJS.ErrnoException).code
  const label = code !== undefined && !error.message.includes(code)
    ? `${error.message} [${code}]`
    : error.message
  const cause = (error as { cause?: unknown }).cause
  if (cause === undefined) return label
  // The generic `fetch failed` adds nothing of its own; skip straight to the cause.
  const generic = error instanceof TypeError && (error.message === 'fetch failed' || error.message.length === 0)
  return generic ? describeCause(cause, depth + 1) : `${label}; ${describeCause(cause, depth + 1)}`
}

function dispatcherFor(ca: string, proxy: string | undefined): Dispatcher {
  const key = `${proxy ?? ''}\n${ca}`
  const cached = dispatchers.get(key)
  if (cached !== undefined) return cached
  const built = proxy === undefined
    ? new Agent({ connect: { ca } })
    : new ProxyAgent({ uri: proxy, requestTls: { ca } })
  dispatchers.set(key, built)
  if (dispatchers.size > DISPATCHER_LIMIT) {
    const oldestKey = dispatchers.keys().next().value as string
    const evicted = dispatchers.get(oldestKey) as Dispatcher
    dispatchers.delete(oldestKey)
    void evicted.close().catch(() => { /* an evicted dispatcher's sockets close when idle */ })
  }
  return built
}

/**
 * Build the fetch implementation one `caFile` route sends its requests through.
 * @param caFile - the route's PEM CA file, re-read on every request.
 * @returns a fetch-compatible function bound to the route's CA trust.
 */
export function caFetchFor(caFile: string): typeof globalThis.fetch {
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // A Request built against the platform fetch is not brand-compatible with
    // the pinned undici's, so it is reduced to the pieces fetch would take
    // from it; init still wins, matching the spec's request/init overlay.
    let raw: string | URL
    let requestInit: RequestInit | undefined = init
    if (typeof input === 'string' || input instanceof URL) {
      raw = input
    } else {
      raw = input.url
      requestInit = {
        ...init,
        method: init?.method ?? input.method,
        headers: init?.headers ?? input.headers,
        body: init?.body ?? input.body,
        // A stream body may only be sent in halves; undici requires the hint.
        duplex: 'half',
      } as RequestInit
    }
    const url = new URL(raw)
    let ca: string
    try {
      ca = await readFile(caFile, 'utf8')
    } catch (cause) {
      const detail = `the route's CA file "${caFile}" could not be read: ${describeCause(cause)}`
      recordFailure(url.origin, detail)
      throw new TypeError(detail, { cause })
    }
    const route = proxyRouteFor(url)
    const dispatcher = dispatcherFor(ca, route.proxied ? route.proxy : undefined)
    try {
      // undici's fetch is behaviorally the platform's, but its typings name
      // their own RequestInit and Response; the cast is the boundary.
      const response = (await undiciFetch(raw, { ...requestInit, dispatcher } as unknown as Parameters<typeof undiciFetch>[1])) as Response
      return response
    } catch (error) {
      recordFailure(url.origin, describeCause(error))
      throw error
    }
  }
  // The undici boundary is reconciled inside: the request closure takes the
  // platform's parameter shape and returns a spec Response.
  return request
}

/** Test hooks for the cause-chain flattener; production never imports them. */
export const internals: { describeCause: (error: unknown, depth?: number) => string } = { describeCause }
