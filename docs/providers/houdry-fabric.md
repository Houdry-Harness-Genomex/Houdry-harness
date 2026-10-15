# Houdry Fabric Provider

Connect DeepSeek Harness to [Houdry](https://github.com/houdry-genomex/houdry) — a private GPU fabric that routes inference to your organization's GPU resources.

## What is Houdry?

Houdry is a sovereign AI execution platform that keeps computation, models, and data within your infrastructure. It:

- Discovers GPUs on your organization's machines
- Forms them into a managed cluster
- Routes inference requests intelligently across available resources
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

The worker finds the control plane via WiFi discovery and stays running.

### 3. Configure provider in DeepSeek Harness

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

### 4. Trust TLS certificate

Since Houdry uses a self-signed CA:

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.houdry/server/pki/root_ca.crt"
npx @deepseek-ai/dsh web
```

`dsh` has no per-provider CA field and trusts certificates only through the process environment, so this export is required rather than one of two options. A plane started with `serve --data DIR` keeps its CA at `DIR/pki/root_ca.crt`. See [Houdry fabric integration](../../integrations/houdry-fabric/INTEGRATION.md) for the launchers that set it.

## Usage

### Model selection

- **`auto`**: Houdry's router analyzes your prompt and selects the best model + GPU node. Requires a node that can actually hold its pick — see the caveat below.
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

## Troubleshooting

### Certificate errors

**Symptom**: TLS handshake failures, certificate invalid

**Fix**: Trust the Houdry Root CA:

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.houdry/server/pki/root_ca.crt"
```

This has to be set before `dsh` launches; it is read at process start, and there is no per-provider certificate field to fall back on.

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

```bash
# Trust Houdry CA for Node.js
export NODE_EXTRA_CA_CERTS="$HOME/.houdry/server/pki/root_ca.crt"

# Override Ollama URL for fabric local fallback (advanced)
export HOUDRY_OLLAMA="http://192.168.1.100:11434"
```

## Security

- **mTLS**: GPU workers use client certificates. The `/v1` API requires only server TLS.
- **Token auth**: Pass `--token` to `houdry serve` for API key authentication. Add it to DeepSeek Harness "API Key" field.
- **Network**: Keep fabric on a private network. Do not expose to public internet without additional auth.

## Links

- Houdry repository: https://github.com/houdry-genomex/houdry
- Fabric documentation: [docs/](https://github.com/houdry-genomex/houdry/tree/main/docs)
- OpenAI-compatible API spec: [docs/OpenAI-compatible-API.md](https://github.com/houdry-genomex/houdry/blob/main/docs/OpenAI-compatible-API.md)
- Houdry Agent (alternative Desktop client): https://github.com/houdry-genomex/houdry-agent

## Comparison: Houdry vs Local Ollama

| Feature | Local Ollama | Houdry Fabric |
|---------|--------------|---------------|
| Setup | Single machine | Multi-node cluster |
| Routing | Manual model selection | Automatic routing (model=auto) |
| GPU pooling | One machine's GPUs | All registered GPU machines |
| Scheduling | None (one request at a time) | Queue + node selection |
| Discovery | localhost:11434 | WiFi mDNS + manual URL |
| Security | No auth | mTLS (workers) + optional token (API) |

Use local Ollama for single-machine development. Use Houdry when you have multiple GPU machines and want intelligent routing.

## Summary

1. Install Houdry fabric: `houdry serve`
2. Register GPU workers: `houdry gpu register`
3. Add Houdry as custom OpenAI provider in DeepSeek Harness settings
4. Trust the CA certificate
5. Chat with `model=auto` for intelligent routing

The integration uses Houdry's standard OpenAI-compatible `/v1` API — no custom code needed.
