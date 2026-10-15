# Houdry fabric integration

A Houdry fabric control plane exposes `POST /v1/chat/completions` and `GET /v1/models` in OpenAI form, so `dsh` reaches a private GPU cluster through the [`dsh-llm-pi-ai`](../../packages/llm/llm-pi-ai/README.md) adapter with no plugin, no fork, and no harness code change. This directory holds the provider route that names the fabric, plus launchers that make Node trust the plane's private certificate authority.

```text
dsh session → pi-ai route "houdry" → https://<plane>:8080/v1/chat/completions
            → Houdry router (model=auto) → READY GPU node, or Ollama on the plane host
```

Provider routes stay out of the shipped profiles on purpose: [`packages/bundle/base/cordis.patch.yml`](../../packages/bundle/base/cordis.patch.yml) states that which adapters exist is composition while which providers run is the user's settings document. `--patch` is the supported third layer, so this overlay reaches a session without editing a bundle or `$DSH_HOME`.

## Prerequisites

- `houdry serve` running, reachable from this machine, with one model served: a worker registered through `houdry gpu register`, or Ollama with a model pulled on the plane host.
- `houdry`'s root CA present locally at `$HOUDRY_HOME/server/pki/root_ca.crt` (default `~/.houdry`), generated on the plane's first `houdry serve`.
- `dsh` installed, or this checkout built and run with `DSH_CMD='pnpm dsh'`.

## Run

```sh
sh integrations/houdry-fabric/start.sh                       # POSIX, installed dsh
sh integrations/houdry-fabric/start.sh --port 9000           # flags pass through to dsh web
pwsh integrations/houdry-fabric/start.ps1                    # Windows
DSH_CMD='pnpm dsh' sh integrations/houdry-fabric/start.sh     # this source checkout
```

The launcher sets `NODE_EXTRA_CA_CERTS` from `$HOUDRY_HOME`, supplies `HOUDRY_FABRIC_KEY` when unset, and applies [`houdry-fabric.overlay.yml`](houdry-fabric.overlay.yml) with the repeatable `--patch` flag. It writes nothing outside its own process environment.

## Route

```yaml
- id: llm-pi-ai
  config:
    providers:
      houdry:
        api: openai-completions
        baseURL: https://127.0.0.1:8080/v1
        apiKeyEnv: HOUDRY_FABRIC_KEY
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        defaultContextWindow: 8192
        defaultMaxTokens: 2048
        models:
          - id: auto
```

Set `baseURL` to the plane's LAN address for a remote control plane. `auto` asks the fabric router to pick per request; a concrete worker model ref pins one model.

| Field | Fabric behavior it accounts for |
|---|---|
| `supportsDeveloperRole: false` | The plane's local path keeps only `user`, `assistant` and `system` turns (`internal/routeropenai/openai.go`, `historyFromMessages`). A `developer` system prompt is dropped with no error, so the model answers without instructions. |
| `maxTokensField: max_tokens` | The plane's request struct declares `max_tokens` alone (`internal/openaicompat/types.go`, `ChatRequest`); an OpenAI `max_completion_tokens` cap is ignored rather than refused. |
| `defaultContextWindow`, `defaultMaxTokens` | `GET /v1/models` returns ids with no capacities (`internal/server/openai_chat.go`, `handleOpenAIModels`) and the fabric catalog stores none, so without these the pi-ai defaults of 262,144 and 32,768 over-promise a small local model. Set them to what the served model actually holds. |
| `apiKeyEnv` | The plane accepts `Authorization: Bearer` or `X-Houdry-Token` and requires neither when `serve` has no `--token` (`internal/server/server.go`, `authorized`). A route naming no credential is still refused by pi-ai's OpenAI client, so the reference carries a placeholder or the real token. |

Both `compat` switches belong to `openai-completions`. A route-level switch no model on that route could read is refused where it is written, so do not add a third one to match another gateway's habits.

## Trust

The plane serves HTTPS from a CA private to the cluster, and Node trusts only its bundled roots, so `NODE_EXTRA_CA_CERTS` must point at `root_ca.crt`. Without it every request fails during the TLS handshake. `/v1` needs no client certificate — node APIs do — so no fabric enrollment step is required to use `dsh` as a client.

Two alternatives reach the same route: **Settings → Models → Add model provider → Custom model API** with protocol **OpenAI Chat Completions**, or appending the entry above to `$DSH_HOME/profiles/web/cordis.patch.yml`, the document that page writes. Adapters re-read it on the next request. See [Configure models](../../docs/user/guide/providers.md) for every field.

## Check

```sh
curl --cacert "$HOME/.houdry/server/pki/root_ca.crt" https://127.0.0.1:8080/v1/models
curl --cacert "$HOME/.houdry/server/pki/root_ca.crt" https://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello from Houdry."}]}'
```

`/v1/models` lists `auto` plus the models present on READY, BUSY or DRAINING workers, falling back to the plane host's local Ollama catalog while no GPU worker is registered, so it is live inventory rather than a fixed catalog. Then select **houdry / auto** in the model picker and send a message.

## Limits

- **Multi-turn tool use needs a registered worker.** The plane's local path collapses history into text-only `user`/`assistant`/`system` turns, so `tool` results and assistant `tool_calls` do not survive a round trip; the cluster path forwards the full message array including `tool_call_id`. For a session that reads files or runs commands, keep at least one node READY.
- **The cluster path streams after completion.** A routed job buffers the answer, then emits SSE chunks; the local path streams tokens live.
- **HTTP/1.1 only.** The plane disables HTTP/2 on its TLS listener.
- **Router picks are heuristic**, so `auto` can choose differently between turns of one session; pin a model ref when a session must hold one.
- **`dsh` is a developer preview.** This route was written against 0.2.1-alpha.3. If a newer build rejects it, re-read [Configure models](../../docs/user/guide/providers.md) and [`packages/llm/llm-pi-ai/src/config.ts`](../../packages/llm/llm-pi-ai/src/config.ts): protocol ids and the `compat` set are validated there and are the authority.
