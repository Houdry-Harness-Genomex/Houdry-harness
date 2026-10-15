# Houdry fabric integration

A Houdry fabric control plane exposes `POST /v1/chat/completions` and `GET /v1/models` in OpenAI form, so `dsh` reaches a private GPU cluster through the [`dsh-llm-pi-ai`](../../packages/llm/llm-pi-ai/README.md) adapter with no plugin, no fork, and no harness code change. This directory holds the provider route that names the fabric, plus launchers that make Node trust the plane's private certificate authority.

```text
dsh session → pi-ai route "houdry" → https://<plane>:8080/v1/chat/completions
            → Houdry router (model=auto) → READY GPU node, or Ollama on the plane host
```

Provider routes stay out of the shipped profiles on purpose: [`packages/bundle/base/cordis.patch.yml`](../../packages/bundle/base/cordis.patch.yml) states that which adapters exist is composition while which providers run is the user's settings document. `--patch` is the supported third layer, so this overlay reaches a session without editing a bundle or `$DSH_HOME`.

## Prerequisites

- `houdry serve` running, reachable from this machine, with one model served: a worker registered through `houdry gpu register`, or Ollama with a model pulled on the plane host.
- `houdry`'s root CA present locally at `$HOUDRY_HOME/server/pki/root_ca.crt` (default `~/.houdry`), generated on the plane's first `houdry serve`. A plane started with `serve --data DIR` keeps its CA at `DIR/pki/root_ca.crt` instead.
- `dsh` installed, or this checkout built with `pnpm run build:artifacts` and run with `DSH_CMD='pnpm dsh'`. Running from source without that build fails while loading type contributors, long before the fabric is contacted.

## Run

```sh
sh integrations/houdry-fabric/start.sh                       # POSIX, installed dsh
sh integrations/houdry-fabric/start.sh --port 9000           # flags pass through to dsh web
pwsh integrations/houdry-fabric/start.ps1                    # Windows
DSH_CMD='pnpm dsh' sh integrations/houdry-fabric/start.sh     # this source checkout
```

The launcher applies [`houdry-fabric.overlay.yml`](houdry-fabric.overlay.yml) with the repeatable `--patch` flag and writes nothing outside its own process environment. Every deployment choice it could not know is an environment seam, read the same way in both launchers:

| Variable | Default | Use |
|---|---|---|
| `HOUDRY_FABRIC_URL` | `https://127.0.0.1:8080/v1` | The plane's address. `8080` is frequently taken on Windows; `serve --port` moves it. |
| `HOUDRY_FABRIC_CA` | `$HOUDRY_HOME/server/pki/root_ca.crt` | Root CA for a plane kept under a non-default `--data` directory. |
| `HOUDRY_FABRIC_KEY` | `houdry` | Placeholder for an untokened plane; the real token for one started with `serve --token`. |
| `DSH_CMD` | `dsh` | Set to `pnpm dsh` to run this checkout rather than an installed build. |


## Route

```yaml
- id: llm-pi-ai
  config:
    providers:
      houdry:
        displayName: Houdry Fabric
        api: openai-completions
        baseURL: !!js process.env.HOUDRY_FABRIC_URL || 'https://127.0.0.1:8080/v1'
        apiKeyEnv: HOUDRY_FABRIC_KEY
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        defaultContextWindow: 8192
        defaultMaxTokens: 2048
        models:
          - id: auto
```

Set `baseURL` to the plane's LAN address for a remote control plane. `auto` asks the fabric router to pick per request; a concrete worker model ref pins one model. `!!js` is Schemastery's inline-expression tag, and it is why the address arrives as environment rather than as a second copy of this file.

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

Prove the plane answers before blaming either side of the seam:

```sh
curl --cacert "$HOME/.houdry/server/pki/root_ca.crt" https://127.0.0.1:8080/v1/models
curl --cacert "$HOME/.houdry/server/pki/root_ca.crt" https://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello from Houdry."}]}'
```

On Windows this fails in `curl` for a reason that has nothing to do with the fabric: schannel treats a private CA as untrusted when it cannot reach a revocation list (`CERT_TRUST_REVOCATION_STATUS_UNKNOWN`). Check the plane through the same trust seam `dsh` uses instead, which is also the assertion that actually matters:

```powershell
$env:NODE_EXTRA_CA_CERTS = "$env:USERPROFILE\.houdry\server\pki\root_ca.crt"
node -e "fetch(process.env.HOUDRY_FABRIC_URL+'/models',{headers:{Authorization:'Bearer '+process.env.HOUDRY_FABRIC_KEY}}).then(r=>r.json()).then(j=>console.log(j.data.map(m=>m.id).join(', ')))"
```

`/v1/models` lists `auto` plus the models present on READY, BUSY or DRAINING workers, falling back to the plane host's local Ollama catalog while no GPU worker is registered, so it is live inventory rather than a fixed catalog. Then select **houdry / auto** in the model picker and send a message.

## Limits

- **Multi-turn tool use needs a registered worker.** The plane's local path collapses history into text-only `user`/`assistant`/`system` turns, so `tool` results and assistant `tool_calls` do not survive a round trip; the cluster path forwards the full message array including `tool_call_id`. For a session that reads files or runs commands, keep at least one node READY.
- **`auto` can queue forever on a GPU too small for its pick.** The router sizes each candidate and requires the node to hold it; when its choice exceeds the free VRAM of every registered node, the job stays `queued` and `POST /v1/chat/completions` never returns, so `dsh` appears to hang with no error. Measured on a 4 GiB node: `auto` chose `qwen2.5-coder:7b` at a 6 GiB requirement and twelve jobs piled up queued. Pin a model ref that fits — `houdry job list --json` shows each queued job's `requirements.min_vram_bytes`, which is where you can read the requirement you have to stay under.
- **A pinned model has to be listed in the route.** `models` gates what the picker and `agent-default-model` accept, so a worker ref the plane will serve but the route omits cannot be selected. Add concrete ids to `models` when pinning.
- **Small models derail on the agent's tool catalog.** `dsh` sends a system prompt and tool list far larger than a 1–2B model can act in; a measured turn on `qwen2.5-coder:1.5b` answered a one-sentence request by inventing `get_goal` / `update_goal` calls, which `dsh` then executed. The transport was correct and the session behaved as configured; the model could not. Size the pinned model to the harness prompt, not to a chat demo.
- **The cluster path streams after completion.** A routed job buffers the answer, then emits SSE chunks; the local path streams tokens live.
- **HTTP/1.1 only.** The plane disables HTTP/2 on its TLS listener.
- **Router picks are heuristic**, so `auto` can choose differently between turns of one session; pin a model ref when a session must hold one.
- **`dsh` is a developer preview.** This route was written against 0.2.1-alpha.3. If a newer build rejects it, re-read [Configure models](../../docs/user/guide/providers.md) and [`packages/llm/llm-pi-ai/src/config.ts`](../../packages/llm/llm-pi-ai/src/config.ts): protocol ids and the `compat` set are validated there and are the authority.

## Measured

Against a plane on `https://127.0.0.1:18081/v1` (`serve --data` with `--token`) and one RTX node:

| Check | Result |
|---|---|
| `GET /v1/models` without a token | `401` |
| `GET /v1/models` with the token | `200`, 10 ids — `auto` plus 9 live worker refs |
| `POST /v1/chat/completions`, `model: auto` | `200` in 2.0s, `model` field `tinyllama:latest` |
| `dsh --profile headless` with this overlay | session recorded `provider: houdry`, `model: qwen2.5-coder:1.5b`, `contextWindow: 8192`; four successive steps round-tripped `tool_calls` and their results; exit 0 |

The `contextWindow: 8192` in that session record is the evidence that the overlay reached the adapter: it is this route's `defaultContextWindow`, not pi-ai's 262,144 default. `auto` was not usable from `dsh` on this node for the VRAM reason above, so the completed turn pinned a model.
