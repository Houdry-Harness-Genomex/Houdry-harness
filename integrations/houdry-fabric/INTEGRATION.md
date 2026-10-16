# Houdry fabric integration

This integration connects the existing Harness Web UI to a private Houdry fabric control plane. The launcher discovers or reconnects to a plane, verifies and pins its certificate authority, resolves its credential and catalog, then writes the `houdry` provider into the Web profile's watched patch document. A session watcher keeps that route current while the Web UI stays open.

```text
resolve.mjs ─┬─ plane       explicit URL → saved plane → UDP/mDNS browse → local listener
             ├─ trust       operator CA → verified pin → local root → trust on first use
             ├─ credential  environment → Harness credential document → keyless placeholder
             └─ catalog     GET /v1/models
                     ↓
$DSH_HOME/profiles/web/cordis.patch.yml
                     ↑
houdry-fabric-watch.mjs ─ verified discovery/reconnect and catalog refresh
                     ↓
dsh web → llm-pi-ai route `houdry` → Houdry `/v1/chat/completions`
```

The route document is watched by Harness. A successful catalog change updates the provider and publishes the adapter update that refreshes open model pickers. The launchers do not use an overlay or export a model list.

## Files

| File | Purpose |
|---|---|
| [`resolve.mjs`](resolve.mjs) | Resolves one usable connection and writes the initial watched route. |
| [`houdry-fabric-watch.mjs`](houdry-fabric-watch.mjs) | One session sidecar per Harness home; reconnects and refreshes the watched route. |
| [`houdry-fabric-patch.mjs`](houdry-fabric-patch.mjs) | Reads and atomically edits only the `llm-pi-ai.providers.houdry` route. |
| [`houdry-connection.mjs`](houdry-connection.mjs) | Discovers a plane, applies trust and credential rules, and reads the catalog. |
| [`houdry-fabric-discover.mjs`](houdry-fabric-discover.mjs) | Browses UDP `41808` and `_houdry._tcp.local`. |
| [`houdry-tls.mjs`](houdry-tls.mjs) | Owns private-host checks, CA pins, verified requests, and TOFU. |
| [`fabric-credentials.mjs`](fabric-credentials.mjs) | Restores and saves the non-secret connection record and the Harness credential reference. |
| [`start.sh`](start.sh) / [`start.ps1`](start.ps1) | Starts `dsh web` and its watcher sidecar. |

## Prerequisites

- A reachable `houdry serve` control plane with at least one served model.
- Node 22+ and an installed `dsh`, or a built checkout with `DSH_CMD='pnpm dsh'`.
- On a non-discoverable network, an explicit `HOUDRY_FABRIC_URL`.
- For a token-protected plane, one `HOUDRY_FABRIC_KEY` export or a key saved through **Settings → Models**.

## Start the Web UI

```sh
sh integrations/houdry-fabric/start.sh
sh integrations/houdry-fabric/start.sh --port 9000
DSH_CMD='pnpm dsh' sh integrations/houdry-fabric/start.sh
```

```powershell
powershell.exe -File integrations/houdry-fabric/start.ps1
```

The launcher resolves and writes `$DSH_HOME/profiles/web/cordis.patch.yml` before it starts `dsh web`, then starts `houdry-fabric-watch.mjs` with the launcher as parent. When the child exits, the launcher stops the watcher. The watcher also notices a missing parent and removes its per-home pidfile.

The route contains a concrete API address and catalog rather than `!!js` expressions:

```yaml
- id: llm-pi-ai
  config:
    providers:
      houdry:
        displayName: Houdry Fabric
        api: openai-completions
        baseURL: https://192.168.1.20:18081/v1
        caFile: /home/you/.houdry-dsh/cas/192.168.1.20_18081.crt
        apiKeyEnv: HOUDRY_FABRIC_KEY
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        defaultContextWindow: 8192
        defaultMaxTokens: 2048
        models:
          - id: auto
```

The route retains the Fabric compatibility values: its local path does not preserve developer turns, its OpenAI request accepts `max_tokens`, and its catalog does not report capacity limits.

## Reconnect and live refresh

While a connection is healthy, the watcher rechecks it every 15 seconds. It rewrites the route only when the Fabric API address or ordered model catalog changes. When a saved plane is unavailable, it returns to the discovery cycle. A discovered LAN plane takes precedence over an older saved address, so a control plane that moved to a new private address can replace the stale route.

The watcher never overwrites a user-managed `!!js` Houdry `baseURL`, a non-Fabric route, malformed YAML, or unrelated profile entries. It edits the profile document with the same writer lock and atomic-write path as the Models page. A page save and watcher update therefore serialize, and comments, sibling plugins, sibling providers, and valid `!!js` values round-trip unchanged.

Harness reloads this profile patch as it changes. The LLM adapter re-registers its provider and browser model catalogs refresh without a Harness Web UI restart. The route's `caFile` is part of that document, so a newly adopted plane is trusted by chat requests as soon as the LLM plugin re-resolves — no `dsh` restart, and the model picker's **Refresh models** control re-reads the catalog on demand instead of waiting for the watcher interval.

## Resolution and trust

The resolver uses these decisions in order:

| Decision | Behavior |
|---|---|
| Plane | `HOUDRY_FABRIC_URL`, then a saved address, then UDP/mDNS discovery, then known local listener ports. |
| Identity | Discovery replies are confirmed through `/.well-known/houdry.json`; addresses for one named plane are collapsed and ranked. |
| CA | `HOUDRY_FABRIC_CA`, then a per-origin verified pin, then a verified local root, then a private-host TOFU pin. |
| Token | `HOUDRY_FABRIC_KEY`, then the Harness credential document, then the keyless placeholder. |
| Catalog | A verified `GET /v1/models`; an empty list still materializes `auto`. |

A first-use CA fetch is limited to private or loopback addresses. Later requests verify through the pin; a changed CA is refused until `--repin` or `HOUDRY_FABRIC_REPIN=1` explicitly replaces it. `HOUDRY_FABRIC_INSECURE` is local-development-only and disables certificate validation for that run.

The route records the CA the connection proved the plane by (`caFile`, the per-origin pin or operator CA path). The `llm-pi-ai` provider verifies every chat request for the route against that file — re-read per request, so a repinned certificate takes effect without a restart — instead of relying on `NODE_EXTRA_CA_CERTS`, which Node reads only at process start and which therefore cannot cover a plane adopted after boot. Verification is never relaxed: the CA adds trust for the route. The launcher exports no Fabric URL or catalog to the Web process. It sets a placeholder `HOUDRY_FABRIC_KEY` only for a keyless plane; a real key is read by Harness through its credential service.

## Persistence

| Value | Location | Rule |
|---|---|---|
| Fabric token | `HOUDRY_FABRIC_KEY` in `$DSH_HOME/.credentials.yaml` | Stored through Harness's locked credential serializer only after the plane accepted an externally supplied token. |
| API address and optional operator CA path | `fabric-connection.json` in `HOUDRY_FABRIC_TOFU_DIR` | Non-secret reconnect record. |
| Per-origin CA pin | `cas/` and `houdry-tofu-ca.json` in `HOUDRY_FABRIC_TOFU_DIR` | TOFU record; CA rotation needs explicit repinning. |

An exported token takes precedence over a saved token. Placeholders, refused tokens, and a trust-ladder pin are never stored as credentials. `--no-save` or `HOUDRY_FABRIC_NO_SAVE=1` prevents connection and credential persistence. Diagnostics and resolver output never expose a real token or signed session URL.

## Configuration

| Input | Default | Effect |
|---|---|---|
| `HOUDRY_FABRIC_URL` | saved plane, then discovery | Pins this connection attempt to one API address. `HOUDRY_BASE_URL` remains an accepted older name. |
| `HOUDRY_FABRIC_CA` | verified pin | Uses an operator-selected PEM before the pin ladder. |
| `HOUDRY_FABRIC_KEY` | saved key, then placeholder | Supplies a token for a protected plane. |
| `HOUDRY_FABRIC_TOFU_DIR` | `~/.houdry-dsh` | Holds pins, the connection record, and watcher pidfile. |
| `HOUDRY_FABRIC_REPIN` | off | Explicitly accepts a replacement CA. |
| `HOUDRY_FABRIC_NO_SAVE` | off | Keeps this launch from saving the connection or token. |
| `HOUDRY_FABRIC_INSECURE` | off | Disables TLS verification for local development only. |
| `DSH_CMD` | `dsh` | Launch command, tokenized with quote-aware rules. |

`resolve.mjs` accepts `--repin`, `--no-save`, `--timeout <ms>`, `--no-mdns`, and `--json`. The watcher accepts `--parent <pid>`, `--once`, `--no-mdns`, and `--timeout <ms>`.

## Verify

```sh
node integrations/houdry-fabric/resolve.mjs --json
node --test integrations/houdry-fabric/tests/watch.test.mjs
pnpm run test:houdry-fabric
```

The watcher suite runs a loopback HTTPS control plane with a test-only CA. It verifies secure TOFU adoption, catalog refresh into the watched patch, no write while a pinned plane is unreachable, preservation of manual routes, and one-watcher cleanup. The connection suite covers discovery, TOFU reuse and rotation, credential persistence, and resolver failure behavior. The loopback recovery and watcher-lifecycle suites cover an endpoint change end to end (old plane gone, new plane adopted, route and catalog rewritten, TLS re-pinned) and the continuous loop's idle, parent-liveness, and shutdown behavior.

For a live plane, open the Web UI model picker after launch, select `houdry`, and compare its models with `GET /v1/models`. Add or remove a model on the control plane and wait one watcher interval; the picker should refresh without restarting the Web UI. Two gated probes exist for a live plane that answers — `HOUDRY_FABRIC_LIVE=1 node integrations/houdry-fabric/tests/provider-chat.manual.mjs` (a real chat completion through the route's `caFile`) and `... chat-error-diagnostic.manual.mjs` (the raw TLS or connection error "Connection error." hides). mDNS packet handling is covered by fixtures but has not been observed against a live advertising Fabric plane.

## Limits

- The watcher controls only the `houdry` provider in the Web profile; a user-managed `!!js` address deliberately stops automatic changes.
- Multiple different discovered plane names are not selected automatically.
- `HOUDRY_FABRIC_INSECURE` relaxes verification only for the launch's own connection checks; chat requests verify against the route's `caFile`, which that mode does not produce — a development plane must present a CA the route records.
- `dsh headless` does not use the saved credential document; export `HOUDRY_FABRIC_KEY` for headless runs.
- A queued `auto` request can wait indefinitely if no worker has enough free VRAM; choose a fitting explicit model when necessary.
