# Houdry Fabric Provider

English | [中文](houdry-fabric.zh.md)

Connect DeepSeek Harness to [Houdry](https://github.com/houdry-genomex/houdry) — a private GPU fabric that routes inference to your organization's GPU resources.

## What is Houdry?

Houdry is a sovereign AI execution platform that keeps computation, models, and data within your infrastructure. It:

- Discovers GPUs on your organization's machines
- Forms them into a managed cluster
- Routes inference requests across available resources
- Exposes an OpenAI-compatible API

DeepSeek Harness uses Houdry as a model backend, similar to how it connects to OpenAI, Anthropic, or local Ollama.

## Architecture

```text
DeepSeek Harness
    ↓
Houdry fabric /v1 API
    ↓
Router (model=auto) + Scheduler
    ↓
GPU worker nodes
    ↓
Model runtimes (Ollama/vLLM/llama.cpp)
```

## Setup

### 1. Install and start Houdry fabric

On your control plane machine:

```bash
curl -fsSL https://github.com/houdry-genomex/houdry/releases/latest/download/install.sh | sh
export PATH="$HOME/.houdry/bin:$PATH"
houdry serve --listen 0.0.0.0:8080
```

### 2. Add GPU workers

On each GPU machine:

```bash
houdry gpu detect
houdry gpu register
```

The worker finds the control plane over the LAN and stays running.

### 3. Start DeepSeek Harness against the fabric

The [Houdry fabric integration](../../integrations/houdry-fabric/INTEGRATION.md) in this repository resolves the plane, its certificate, credential and live catalog, writes the provider into the Web profile's watched patch document, then starts the Web UI with a session watcher.

```sh
sh integrations/houdry-fabric/start.sh                # POSIX shells
```

```powershell
pwsh integrations/houdry-fabric/start.ps1             # Windows
```

The launcher runs `node integrations/houdry-fabric/resolve.mjs` first. That resolver makes the same four decisions the [Houdry Agent](https://github.com/houdry-genomex/houdry-agent) makes in its own client, in the same order:

| Decision | How it is reached |
|---|---|
| Which plane | An address you exported, else a LAN browse over UDP `41808` and mDNS `_houdry._tcp.local`, with each reply confirmed through `/.well-known/houdry.json`, else a control plane already listening here on `18080`, `8090` or `8080`. |
| Which certificate | `HOUDRY_FABRIC_CA` you point at, else the CA already pinned for that plane's origin, re-checked against the plane before use, else the root in `~/.houdry/server/pki`, else a first-use fetch of `/v1/pki/ca` — refused for any host outside your private network. |
| Which credential | `HOUDRY_FABRIC_KEY` if you exported one, else the token the last launch that worked stored; a plane advertising `auth` with neither stops the launch. |
| Which models | `GET /v1/models` on that plane, listed now, so the model picker holds what the cluster can actually serve. |

Pins live in `~/.houdry-dsh`: one `houdry-tofu-ca.json` record per origin, and one PEM per origin under `cas/`, because `NODE_EXTRA_CA_CERTS` names a single file that Node then trusts for every host.

Nothing is launched until all four have answered. A plane you cannot reach, a CA that changed since you last pinned it, a plane asking for a token you did not export, and a catalog that refuses to list each stop with exit 2 and a message naming the address and the file — rather than surfacing later as a model error.

Export the token once and the launch that the plane authenticates keeps it. The address goes beside the pins, in `fabric-connection.json` inside the trust directory; the token goes into `$DSH_HOME/.credentials.yaml`, the document `dsh` reads every provider key from — the same one **Settings → Models** writes. A restart with an empty environment then reconnects to that plane and resolves the key again inside `dsh`, so the token is never carried back out through the launcher. An exported value always outranks the stored one for the run that exports it, and `--no-save` keeps a launch from remembering anything. `dsh headless` does not read that document at all — Troubleshooting says why.

### 4. Or configure the provider by hand

1. Open Settings → Models
2. Click "Add model provider"
3. Select "Custom model API"
4. Fill in:
   - **Name**: `Houdry Fabric`
   - **Protocol**: `OpenAI Chat Completions`
   - **Base URL**: `https://<fabric-host>:8080/v1`
   - **API Key**: (leave empty unless fabric has `--token`)
5. Click "Fetch available models"
6. Select models to enable
7. Save

Then trust the plane's certificate authority before starting `dsh`, because an `openai-completions` route has no CA field and Node trusts only its bundled roots:

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.houdry/server/pki/root_ca.crt"
npx @deepseek-ai/dsh web
```

A plane started with `serve --data DIR` keeps its CA at `DIR/pki/root_ca.crt`. A manually configured provider is not watched by the integration, so its address and model list stay as saved. The integration-managed route refreshes model changes in the Web UI; a CA change still needs `dsh` restarted because Node reads `NODE_EXTRA_CA_CERTS` at process start.

A key saved on that page is written to `$DSH_HOME/.credentials.yaml` under the reference the route names. The fabric route names `HOUDRY_FABRIC_KEY`, so a launch through the integration scripts reads the copy you typed there instead of asking for it again.

## Usage

### Model selection

- **`auto`**: Houdry's router analyzes your prompt and selects the best model and GPU node. Requires a node that can actually hold its pick — see the caveat below.
- **Explicit model** (e.g., `qwen2.5-coder:1.5b`): Pins to that model; Houdry still picks the node

The router considers:

- Prompt modality (text, code, vision, documents)
- Complexity (0-100 score)
- Model capabilities (chat, code, reasoning, vision, tools)
- GPU availability (VRAM, model already loaded)
- Node status (READY, not BUSY)

If the selected model needs more VRAM than any registered node can free, the job stays `queued` and the request returns nothing until `--openai-wait` expires. `houdry job list --json` prints each queued job's `requirements.min_vram_bytes` against `houdry node list`, which is where you read the fit.

### Function calling

Houdry supports OpenAI-style function calling when using tool-capable models. The fabric forwards `tools` and `tool_choice` to the model runtime and returns structured `tool_calls`.

Two conditions on that, both measured against `dsh`:

- **Only the cluster path keeps a tool transcript.** A routed job forwards the full message array including `tool_call_id`, so successive steps see their own results. The plane's local fallback collapses history to text-only `user`/`assistant`/`system` turns, so tool calls and results are dropped without an error. Keep a GPU node READY for any session that uses tools.
- **The model has to be large enough for the harness prompt.** `dsh` sends a system prompt and tool catalog far larger than a chat demo's. A measured turn on `qwen2.5-coder:1.5b` answered a plain one-sentence request by inventing `get_goal` / `update_goal` calls. Size the model to the harness, not to the API.

### Streaming

Streaming is supported. The fabric currently buffers the full response then streams it (post-completion SSE). Token-by-token runtime streaming is planned.

## Verification

Test connectivity before configuring DeepSeek Harness:

```bash
curl --cacert "$HOME/.houdry/server/pki/root_ca.crt" \
  https://127.0.0.1:8080/v1/models
```

Expected: JSON list with `"id": "auto"` plus available models.

Chat completion test:

```bash
curl --cacert "$HOME/.houdry/server/pki/root_ca.crt" \
  https://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Checking the plane through Node

On Windows, `curl` fails on a private CA for a reason that has nothing to do with the fabric: schannel reports `CERT_TRUST_REVOCATION_STATUS_UNKNOWN` when it cannot reach a revocation list. Check the plane through the same certificate trust `dsh` uses, which is the assertion that matters:

```powershell
$env:NODE_EXTRA_CA_CERTS = "$env:USERPROFILE\.houdry\server\pki\root_ca.crt"
node -e "fetch(process.env.HOUDRY_FABRIC_URL+'/models',{headers:{Authorization:'Bearer '+process.env.HOUDRY_FABRIC_KEY}}).then(r=>r.json()).then(j=>console.log(j.data.map(m=>m.id).join(', ')))"
```

### Checking the Web UI

`/v1/models` is live inventory. After launching through the integration:

1. Open the model picker and choose the `houdry` provider.
2. Check the list against `node integrations/houdry-fabric/resolve.mjs --json`, which prints the ids initially written to the watched profile route.
3. Add or remove a served model, wait up to 15 seconds, and confirm that the picker refreshes without restarting the Web UI.
4. Send one message with `auto` and one with a pinned ref that fits your node, then confirm both in `houdry job list`.

The watcher preserves a user-managed `!!js` Houdry address and stops instead of replacing it. A manual route or a changed CA needs an appropriate explicit configuration or a `dsh` restart.

## Troubleshooting

### Certificate errors

**Symptom**: TLS handshake failures, certificate invalid

**Fix**: Trust the Houdry Root CA:

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.houdry/server/pki/root_ca.crt"
```

This has to be set before `dsh` launches; it is read at process start, and there is no per-provider certificate field to fall back on.

If you launch through the integration scripts and the plane's CA was rebuilt — a new `serve --data` directory, a regenerated PKI — the launcher stops instead of trusting the new certificate, because a CA that changed without you saying so is what a man in the middle looks like. Confirm the plane is the one you expect, then re-pin with `--repin` on the command line or `HOUDRY_FABRIC_REPIN=1` in the environment. Only a plane that is not answering at all is treated as transient, and the existing pin is kept with a note.

### No models available

**Check**:

- Fabric is running: `curl --cacert ~/.houdry/server/pki/root_ca.crt https://127.0.0.1:8080/healthz`
- GPU worker is registered: `houdry node list --server https://127.0.0.1:8080`
- Models exist on worker: `houdry model list --server https://127.0.0.1:8080`

If no GPU worker, start local Ollama on the control plane machine as fallback.

### Request timeout

**Default timeout**: 10 minutes

**Increase it**:

```bash
houdry serve --openai-wait 15m
```

Check node status — a BUSY node won't accept new jobs until its current work completes. A job that never starts at all is usually a fit problem: the router's model needs more VRAM than the node has, so it queues instead of failing.

### Model not found

The model is in the catalog but not pulled on any worker:

```bash
# On GPU worker machine
ollama pull tinyllama
```

### Asked for the token again after a restart

**Symptom**: the launcher stops with "this plane asks for a token and none was exported or stored", on a plane you connected to yesterday.

The stored token lives in the harness home, so a home that is not the one yesterday's launch wrote is a document that does not hold it: a different user, a container, or `DSH_HOME` set by whatever starts `dsh`. Check that variable first. `dsh headless` never reads that document — one-shot jobs are given their credentials at launch by design — so it needs `HOUDRY_FABRIC_KEY` exported every time. A launch that used `--no-save`, or `HOUDRY_FABRIC_NO_SAVE`, stored nothing either.

When the message names the **stored** token instead, the plane did answer and rejected what the document holds: it was started with a different `serve --token` than the one remembered. Export the current value and the next launch that authenticates replaces the stored copy; the refused value is never kept. The same goes for a key you type on **Settings → Models**, which writes that document directly.

### The plane is reachable but never discovered

`houdry serve` asks the system to allow inbound UDP `41808` and its TCP port. Run without elevation on Windows, it prints the `netsh` command it could not apply and continues to serve loopback only, so a LAN peer never hears the probe. A guest SSID that isolates clients blocks the same browse from the other side. `HOUDRY_FABRIC_URL` is the route in for a plane you can reach but not discover, and `--no-mdns` narrows the browse to UDP when a network drops multicast.

## Configuration Reference

### Provider fields

| Field | Value |
|-------|-------|
| Name | `Houdry Fabric` (or custom) |
| Protocol | `OpenAI Chat Completions` |
| Base URL | `https://<host>:8080/v1` |
| API Key | Empty (or fabric `--token` value) |
| TLS trust | `NODE_EXTRA_CA_CERTS` on the `dsh` process; no per-provider field exists |

### Environment variables

Read by `resolve.mjs` and its session watcher. The launchers pass the CA and, for a keyless plane, the placeholder key to `dsh`; they do not export the resolved Fabric URL or model catalog.

| Variable | Default | Use |
|---|---|---|
| `HOUDRY_FABRIC_URL` | the saved plane, else *discovered* | Uses this address instead of the one the last launch recorded or a LAN browse. `HOUDRY_BASE_URL` is accepted as the older name. |
| `HOUDRY_FABRIC_KEY` | the stored token, else `no-key-required` | The plane's `serve --token` value. The default is a placeholder, because pi-ai's client refuses a route that names no credential. |
| `HOUDRY_FABRIC_CA` | *pinned on first use* | A CA file you obtained another way; it outranks the pin. |
| `HOUDRY_FABRIC_TOFU_DIR` | `~/.houdry-dsh` | Where the per-origin pins and the saved plane address live. |
| `HOUDRY_FABRIC_REPIN` | *off* | `1`, `true`, `yes` or `on` re-pins the CA for this launch. |
| `HOUDRY_FABRIC_NO_SAVE` | *off* | The same four values keep this launch from recording the plane or its token. |
| `HOUDRY_FABRIC_INSECURE` | *off* | The same four values skip certificate verification. Local development only. |
| `DSH_CMD` | `dsh` | The command to launch, split with quotes honored, e.g. `pnpm dsh`. |

Resolver flags: `--repin`, `--no-save`, `--timeout <ms>`, `--no-mdns`, `--json`. Fabric-side variables such as `HOUDRY_OLLAMA` belong to `houdry serve`, not to this launcher:

```bash
# Override Ollama URL for fabric local fallback (advanced)
export HOUDRY_OLLAMA="http://192.168.1.100:11434"
```

## Security

- **mTLS**: GPU workers use client certificates. The `/v1` API requires only server TLS.
- **Token auth**: Pass `--token` to `houdry serve` for API key authentication. Add it to DeepSeek Harness "API Key" field, or export it once and the launch the plane authenticates stores it. Either way the copy is `$DSH_HOME/.credentials.yaml`, written under a lock at mode 0600 in a 0700 directory and kept as recoverable plaintext: a process running as your user can read it, no OS keychain is wired in, and on Windows the protection comes from your account's ownership rather than a mode bit. It is never written to the trust directory, never printed on the launcher's stdout, and never passed in the launched process's command line.
- **First contact**: The one CA fetch that has no pin to check against is unverified, so pinning is refused outside a private or loopback address range, and every later run re-checks the plane through the pinned CA.
- **Network**: Keep fabric on a private network. Do not expose to public internet without additional auth.

## Links

- Houdry repository: https://github.com/houdry-genomex/houdry
- Fabric documentation: [docs/](https://github.com/houdry-genomex/houdry/tree/main/docs)
- OpenAI-compatible API spec: [docs/OpenAI-compatible-API.md](https://github.com/houdry-genomex/houdry/blob/main/docs/OpenAI-compatible-API.md)
- Houdry Agent (alternative Desktop client): https://github.com/houdry-genomex/houdry-agent
- Integration and resolver: [INTEGRATION.md](../../integrations/houdry-fabric/INTEGRATION.md)
- Every provider field: [Configure models](../user/guide/providers.md)

## Comparison: Houdry vs Local Ollama

| Feature | Local Ollama | Houdry Fabric |
|---------|--------------|---------------|
| Setup | Single machine | Multi-node cluster |
| Routing | Manual model selection | Automatic routing (model=auto) |
| GPU pooling | One machine's GPUs | All registered GPU machines |
| Scheduling | None (one request at a time) | Queue + node selection |
| Discovery | localhost:11434 | LAN browse over UDP and mDNS, or a manual URL |
| Security | No auth | mTLS (workers) + optional token (API) |

Use local Ollama for single-machine development. Use Houdry when you have multiple GPU machines and want routing across them.

## Summary

1. Install Houdry fabric: `houdry serve`
2. Register GPU workers: `houdry gpu register`
3. Start Harness with `sh integrations/houdry-fabric/start.sh`, or add Houdry as a custom OpenAI provider in Settings and export `NODE_EXTRA_CA_CERTS`
4. Send a message with `model=auto`, or pin a ref that fits your node

The integration uses Houdry's standard OpenAI-compatible `/v1` API — no harness code change.
