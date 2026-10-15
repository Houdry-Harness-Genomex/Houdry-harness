# Houdry fabric integration

A Houdry fabric control plane exposes `POST /v1/chat/completions` and `GET /v1/models` in OpenAI form, so `dsh` reaches a private GPU cluster through the [`dsh-llm-pi-ai`](../../packages/llm/llm-pi-ai/README.md) adapter with no plugin, no fork, and no harness code change. This directory holds the provider route that names the fabric, plus the connection the Houdry Agent makes — browse, identity, pin, credential, catalog — reproduced here in ~2,200 lines of dependency-free Node that a shell launcher drives.

```text
resolve.mjs ─┬─ plane     explicit URL → saved plane → LAN browse (UDP 41808 + mDNS) → a plane already listening here
             ├─ trust     insecure → HOUDRY_FABRIC_CA → existing pin → local houdry root → trust on first use
             ├─ credential HOUDRY_FABRIC_KEY → the stored copy → the placeholder a keyless endpoint still demands
             └─ catalog   GET /v1/models as this plane answers it right now
                     ↓  tab-delimited URL / CA / KEY / MODELS / NAME / ARG on stdout
start.sh|start.ps1  exports it, then `dsh web --patch houdry-fabric.overlay.yml`
                     ↓
dsh session → pi-ai route "houdry" → https://<plane>:<port>/v1/chat/completions
            → Houdry router (model=auto) → READY GPU node, or Ollama on the plane host
                     ↑
a launch the plane authenticated is remembered: the token in `$DSH_HOME/.credentials.yaml`,
the address in the trust directory, so the next restart needs no environment at all
```

Provider routes stay out of the shipped profiles on purpose: [`packages/bundle/base/cordis.patch.yml`](../../packages/bundle/base/cordis.patch.yml) states that which adapters exist is composition while which providers run is the user's settings document. `--patch` is the supported third layer, so this overlay reaches a session without editing a bundle or `$DSH_HOME`.

## Files

| File | Holds |
|---|---|
| [`resolve.mjs`](resolve.mjs) | The only entry point a launcher calls: parse flags, run `connectFabric`, print the resolved fields, exit 0 or 2. |
| [`houdry-connection.mjs`](houdry-connection.mjs) | The four ladders above, plus the fabric's own error taxonomy and a `fabricChatCompletion` that writes the request body `dsh`'s route will send — `max_tokens`, not `max_completion_tokens`, and no `developer` turn. |
| [`houdry-fabric-discover.mjs`](houdry-fabric-discover.mjs) | UDP `41808` browse and the dependency-free mDNS/DNS-SD browse, dedupe by URL, collapse by plane name. |
| [`houdry-tls.mjs`](houdry-tls.mjs) | Private-host test, `rewriteHoudryHttps`, the pin store, the never-throw GET/POST transport, and `NODE_EXTRA_CA_CERTS` handling. |
| [`fabric-credentials.mjs`](fabric-credentials.mjs) | What a launch restores and remembers, through the product's own credential document, parser, writer lock and home resolver — see [Credentials](#credentials). |
| [`dsh-command.mjs`](dsh-command.mjs) | `DSH_CMD` → argv, with quote-aware tokenizing so a path containing a space stays one argument. |
| [`houdry-fabric.overlay.yml`](houdry-fabric.overlay.yml) | The `llm-pi-ai` provider route, read through `--patch`. |
| [`start.sh`](start.sh) / [`start.ps1`](start.ps1) | POSIX and Windows launchers over the same resolver output. |
| [`tests/`](tests/) | `node --test` suites over all of it, including the two wire shapes the fabric actually speaks. |

## Prerequisites

- `houdry serve` running and reachable from this machine, with one model served: a worker registered through `houdry gpu register`, or Ollama with a model pulled on the plane host.
- `node` on `PATH` (the resolver is Node 22+ with no dependencies), and `dsh` installed, or this checkout built with `pnpm run build:artifacts` and run with `DSH_CMD='pnpm dsh'`. Running from source without that build fails while loading type contributors, long before the fabric is contacted.
- Nothing else on the first run of a plane that advertises: the resolver finds it and pins its CA. `serve --no-lan-discover`, or a WiFi that isolates clients, leaves discovery blind — set `HOUDRY_FABRIC_URL` in that case.
- The token once, for a plane started with `serve --token`: either exported as `HOUDRY_FABRIC_KEY` or filled in on **Settings → Models**. The first launch the plane authenticates stores it, and no later restart asks again — see [Credentials](#credentials).

## Run

```sh
sh integrations/houdry-fabric/start.sh                       # POSIX, installed dsh
sh integrations/houdry-fabric/start.sh --port 9000           # flags pass through to dsh web
pwsh integrations/houdry-fabric/start.ps1                    # Windows
DSH_CMD='pnpm dsh' sh integrations/houdry-fabric/start.sh     # this source checkout
```

Each launcher runs `node resolve.mjs`, exports what it settled on, and boots `dsh web` with [`houdry-fabric.overlay.yml`](houdry-fabric.overlay.yml) applied through the repeatable `--patch` flag. It writes outside its own process environment only at the two places [Credentials](#credentials) names: the pin store and, after a plane authenticates, the saved connection. `resolve.mjs` may also be run alone — `node resolve.mjs --json` prints the same resolution as one object, which is how the tables below were read rather than guessed.

Deployment choices it could not know are overridable through environment variables, read the same way in both launchers:

| Variable | Default | Use |
|---|---|---|
| *discovered* | the saved plane first, then UDP `41808` + mDNS browse | With no `HOUDRY_FABRIC_URL`, the resolver retries the plane the last authenticated launch recorded, and browses the LAN when that address no longer answers. `--timeout <ms>` widens each probe past its 2 s. |
| `HOUDRY_FABRIC_URL` | the saved plane, else *discovered* | Skips both the saved address and discovery and uses this one; `HOUDRY_BASE_URL` is accepted as the Agent's older name. A bare origin gets `/v1`, and `http://` is upgraded to `https://`. |
| `HOUDRY_FABRIC_CA` | pinned on first use | A PEM already on disk outranks the pin: a plane kept under `serve --data DIR` holds its CA at `DIR/pki/root_ca.crt`. A path that does not exist is reported and the pin is used. |
| `HOUDRY_FABRIC_KEY` | the stored token, else `no-key-required` | Placeholder for an untokened plane; the real token for one started with `serve --token`. A plane advertising `auth` with no key exported or stored is refused before `dsh` starts, not after. |
| `HOUDRY_FABRIC_TOFU_DIR` | `~/.houdry-dsh` | Where the pin store, its per-origin PEMs, and the saved plane address live. |
| `HOUDRY_FABRIC_INSECURE` | — | `1/true/yes/on` skips certificate verification entirely. Local development only; the resolver says so on stderr every time it applies. |
| `HOUDRY_FABRIC_REPIN` | — | Any of the same four values re-pins the CA, which is what `houdry serve` after a rebuilt PKI needs. `--repin` does the same for one run. |
| `HOUDRY_FABRIC_NO_SAVE` | — | Any of the same four values remembers nothing from this launch, which is what a throwaway token or a borrowed plane needs. `--no-save` does the same for one run. |
| `DSH_CMD` | `dsh` | The `dsh` command line, tokenized with quotes honored. Set to `pnpm dsh` to run this checkout rather than an installed build. |
| `HOUDRY_FABRIC_MODELS` | *from the plane* | Exported by the launcher for the overlay's `!!js` model list. Set it by hand only when launching `dsh` without a launcher. |

## Launcher protocol

`resolve.mjs` answers in a line-per-field, tab-delimited form on stdout and keeps every diagnostic on stderr, prefixed `houdry:`. The split exists because a value that arrived from anywhere on the LAN — a plane name a stranger chose — must never be parsed by a shell. Both launchers read each line as two literal fields (`IFS=$'\t' read -r field value`, `"$line" -split "`t", 2`) and assign; nothing is `eval`'d, and each value is flattened of tab and newline by the resolver before printing so one field always occupies one line.

| Field | Contents | Absent when |
|---|---|---|
| `URL` | the plane's API base, e.g. `https://192.168.1.20:18081/v1` | never on exit 0 |
| `CA` | one PEM file, trusted by being in `NODE_EXTRA_CA_CERTS` | `HOUDRY_FABRIC_INSECURE` is on, or plane is http-trusted elsewhere |
| `KEY` | the placeholder `no-key-required` | a real token was used, exported or stored: it is never copied back out of the process that resolved it |
| `MODELS` | comma-joined ids the plane is serving now | never on exit 0 |
| `NAME` | the name the plane reported in its identity document | it reported none |
| `ARG` | one word of the `dsh` command line, from `DSH_CMD` | `DSH_CMD` empty, where the launcher keeps `dsh` |

Exit status is the other half of the protocol: `0` means a plane is usable and the fields may be exported; `2` means it is not, and the launchers stop with `exit 2` rather than starting `dsh`.

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
        models: !!js (process.env.HOUDRY_FABRIC_MODELS || 'auto').split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id }))
```

Set `baseURL` to the plane's LAN address for a remote control plane. `auto` asks the fabric router to pick per request; a concrete worker model ref pins one model. `!!js` is Schemastery's inline-expression tag, and it is why the address and the catalog arrive as environment rather than as a second copy of this file. Both expressions are evaluated when the profile loads, so a plane that moves needs `dsh` restarted. Inside a plain `!!js` scalar, `: ` ends the scalar — hence `.map(id => ({ id }))` rather than `.map(id => ({ id: x }))`.

| Field | Fabric behavior it accounts for |
|---|---|
| `supportsDeveloperRole: false` | The plane's local path keeps only `user`, `assistant` and `system` turns (`internal/routeropenai/openai.go`, `historyFromMessages`). A `developer` system prompt is dropped with no error, so the model answers without instructions. |
| `maxTokensField: max_tokens` | The plane's request struct declares `max_tokens` alone (`internal/openaicompat/types.go`, `ChatRequest`); an OpenAI `max_completion_tokens` cap is ignored rather than refused. |
| `defaultContextWindow`, `defaultMaxTokens` | `GET /v1/models` returns ids with no capacities (`internal/server/openai_chat.go`, `handleOpenAIModels`) and the fabric catalog stores none, so without these the pi-ai defaults of 262,144 and 32,768 over-promise a small local model. Set them to what the served model actually holds. |
| `apiKeyEnv` | The plane accepts `Authorization: Bearer` or `X-Houdry-Token` and requires neither when `serve` has no `--token` (`internal/server/server.go`, `authorized`). A route naming no credential is still refused by pi-ai's OpenAI client, so the reference carries a placeholder or the real token. |
| `models` | Live inventory, listed by the resolver before `dsh` boots, so the picker holds what this cluster can serve now instead of a stale hand-written list. With no launcher, it falls back to `auto`. |

Both `compat` switches belong to `openai-completions`. A route-level switch no model on that route could read is refused where it is written, so do not add a third one to match another gateway's habits.

## Resolution

The ladder is the Agent's, in the Agent's order, adapted only where the fabric's own server code says otherwise.

| Step | What it does | Fabric code it mirrors |
|---|---|---|
| Browse | Probe `255.255.255.255`, `239.255.77.77` and every interface broadcast on UDP `41808` with `{"houdry":"discover","v":1}`, and ask `_houdry._tcp.local` for a PTR on `224.0.0.251:5353`, resolving SRV → A/AAAA and reading the TXT keys `txtvers/path/version/auth/openai/proto`. Accept a UDP reply only on kind, version and a non-empty `url`. Dedupe by URL, backfilling names between transports. | `internal/discovery/{protocol,browse}.go` |
| Confirm | `GET /.well-known/houdry.json` must answer `{houdry:'control-plane',v:1}`; `/healthz` is a second, weaker look. An answer that fails this is kept as a fallback rather than discarded, because guest WiFi can block HTTP while UDP still replies. | `Verify`, `Resolve` |
| Choose | Several addresses of one plane collapse by the name the plane reports — `houdry serve` on a laptop with a vSwitch answers on its WLAN address, the switch address and loopback — ranked by `lanAddressScore`, loopback last. Two *different* names refuse to choose. | `houdry discover` |
| Adopt | Nothing found, but a control plane answers `https://127.0.0.1:<port>` on `18080`, `8090` or `8080`? Use it. LAN before loopback on purpose: `serve` binds `0.0.0.0` and announces its real interface address, so preferring loopback would instead pin a leftover local instance. | `internal/server/server.go` |

Browse and adopt are separate from `isHoudryLanHttps`, which is only about pinning: `houdry serve` falls back from `18080` to whatever port is free, so a fixed port list is a proxy for "this is a control plane", never proof. When the caller has already read `/.well-known/houdry.json` from an origin — or reached it on loopback, where a stranger cannot position itself — it passes `confirmed`, and the port half of the test relaxes while the private-host half stays absolute. That is the only deviation from the Agent's client, whose Electron window has no browse step to be confirmed by.

## Trust

The plane serves HTTPS from a CA private to the cluster, and Node trusts only its bundled roots, so `NODE_EXTRA_CA_CERTS` must point at `root_ca.crt`. Without it every request fails during the TLS handshake. `/v1` needs no client certificate — node APIs do — so no fabric enrollment step is required to use `dsh` as a client.

`dsh` has no place to put a CA: the `openai-completions` route takes `baseURL`, `apiKeyEnv`, `compat`, headers and a transport of `sse|websocket|websocket-cached|auto`, and [`packages/llm/llm-pi-ai/README.md`](../../packages/llm/llm-pi-ai/README.md) states plainly that there is no custom certificate authority. That is why the CA arrives through the process environment, read once at boot, rather than through the route.

Because that variable is one file trusted for every host, pins cannot share a file. Each origin gets its own:

```text
~/.houdry-dsh/houdry-tofu-ca.json      {origin: {fingerprint, pem}}, mode 0600, the Agent's store shape
~/.houdry-dsh/cas/<sha256(origin)[0:16]>.crt   the PEM Node is handed, mode 0600 under a 0700 directory
```

`NODE_EXTRA_CA_CERTS` points at the `cas/` file for the one plane this launch resolved, so a second cluster on this machine is trusted only while talking to that cluster. The JSON store is what a rotation is detected against: the resolver re-fetches `/v1/pki/ca` *through the pinned CA* and compares DER, so the two copies cannot drift apart unnoticed, and `houdry-tls.mjs`'s module-level store path is configured before any request runs.

Three consequences worth knowing before they surprise you:

- **First contact is unverified, like the Agent's.** The initial CA fetch is the one request made without checking the chain, so anyone positioned on the LAN at the moment you first connect can be the one you pin. That is why the fetch is refused outside a private address, and why pinned thereafter `--repin` is the only way back — which makes a refused rotation visible rather than silent.
- **Rotation is refused, not tolerated.** A plane whose PKI was rebuilt fails with a message naming the pin file and the address, and points at `HOUDRY_FABRIC_REPIN`. Only a plane that is not answering at all is treated as transient and left alone, and a plane that answers `/v1/pki/ca` with anything other than a certificate keeps the existing pin with a note.
- **A local root is verified, not assumed.** When `~/.houdry/server/pki/root_ca.crt` exists, it is the one copy of a CA that did not come over the network, so it wins — but only after a request to the origin succeeds *verified against it*, which is what stops a home directory belonging to a different cluster from pinning this one.

## Credentials

A launch that the plane authenticated is remembered, so a restart reconnects without exporting the token again. Two files hold it, and each holds one kind of thing:

| Remembered | Where | Written when |
|---|---|---|
| The plane token | `HOUDRY_FABRIC_KEY` in `$DSH_HOME/.credentials.yaml` | the catalog probe came back authenticated, and the token came from outside that document |
| The plane address, and a CA path the operator named | `fabric-connection.json` in the trust directory | a launch resolved a plane, whether or not it was tokened |

The credential document is the product's own store — [`packages/credentials/credentials-local`](../../packages/credentials/credentials-local/), mounted by [`packages/bundle/base/cordis.patch.yml`](../../packages/bundle/base/cordis.patch.yml) — which is what `dsh`, `dsh web` and the desktop app resolve `apiKeyEnv` through, and what **Settings → Models** writes. The launcher reaches it by importing that package's built `lib/`: its parser, its `renderRef` serializer, its writer lock and its home resolver. A launcher that kept its own copy of the token would put the same secret in a second file with a second set of rules about locking, permissions, hot reload, and rotation.

Restoring fills only what the environment left blank, so an exported value always outranks a stored one; a blank or whitespace-only export counts as unset. Both rungs sit below `HOUDRY_FABRIC_URL` in the plane ladder above, and a saved address that no longer answers falls through to discovery — a record of what replied last time is not a promise about this machine.

Three things are deliberately not stored:

- **A placeholder.** `no-key-required` is what a keyless endpoint is handed, not a credential anyone owns.
- **A pin the trust ladder chose.** `HOUDRY_FABRIC_CA` is trusted without re-verification, so writing a trust-on-first-use pin there would silence the rotation warning the pin store exists to raise. The pin already persists on its own in the store beside it.
- **A refused token.** A plane that rejected a credential is a reason to stop, not a reason to overwrite what is stored.

A real token never travels through the launcher protocol either: the `KEY` field carries only the placeholder, because `dsh` resolves `HOUDRY_FABRIC_KEY` through the credentials service itself. The secret stays out of stdout, out of the child's argv, and out of the launcher's environment handoff. Diagnostics name which copy of a credential a plane refused — the exported one or the stored one — and never print its value or any part of it.

Two properties of the store are worth knowing before relying on it. Values are kept as recoverable plaintext in that YAML document, protected by mode 0600 under a 0700 directory, a cross-process writer lock, and on POSIX a refusal to read a document readable beyond its owner; an OS-keychain provider is a pluggable alternative through the same `CredentialProvider` interface, and none is shipped. And [`packages/bundle/headless/cordis.patch.yml`](../../packages/bundle/headless/cordis.patch.yml) disables the credentials plugin on purpose — one-shot jobs use launch-time credentials — so `dsh headless` does not read what the launcher stored and still needs `HOUDRY_FABRIC_KEY` exported. `--no-save` keeps any launch from writing either file.

Before `pnpm run build:artifacts` has produced the `lib/` these modules import, persistence is unavailable and the launcher says so on stderr once, then works from the environment alone: losing persistence never loses a plane that was named on the command line.

## Fail before launch

Two surfaces would otherwise meet in the middle of a chat: a route whose address, credential, trust and model list come from the environment, and a pi-ai client that reports a failure as a model error. The resolver therefore refuses to print anything until each rung has answered, and both launchers stop on its exit 2.

| Code | Means | Why stopping beats starting |
|---|---|---|
| `plane` | No explicit address, nothing on the LAN, nothing listening here | The message lists the reasons each rung failed, and names any port among `18080/8090/8080` where something answers HTTP but is not a control plane — the difference between starting the plane and opening a firewall. |
| `public` | A non-private host, or a private one on a port `houdry serve` never uses, that identity did not confirm | Trust on first use over an unverified connection is only defensible inside a network you control. |
| `rotated` | The CA behind the pin differs by DER | Continuing would hand `dsh` a root guaranteed to fail on the first message, naming the model rather than the certificate. |
| `no_ca` / `unreachable` | `/v1/pki/ca` answered with no certificate, or nothing answered | Same distinction in the other direction: a plane that is down is not a plane that moved. |
| `auth` | The plane advertises `auth` and no usable `HOUDRY_FABRIC_KEY` is exported or stored | A `401` inside a session reads as the model refusing; here it names the address, and asks for the token rather than guessing one. |
| `unauthorized` | The catalog request came back `401`/`403` after a key that looked usable | The report says which copy lost — the exported one, or the one in the credential document — and that the refused copy was not stored, because a stale or truncated token is otherwise invisible. |
| `invalid_json`, `no_suitable_node`, `runtime_error`, … | Any other catalog failure, described with the fabric's own code | `listFabricModels` reads both error shapes the plane writes — the flat `{"error":…}` from `authorized()` and the nested `{message,type,code}` from `openaicompat.WriteError` — so the code that comes here is the server's, not a guess. |

A plane that answers but lists no models is *not* a failure: the router still serves `auto`, so the resolver notes the empty catalog and launches. A plane that answers nothing is, because there is no model to route to.

Two alternatives reach the same route: **Settings → Models → Add model provider → Custom model API** with protocol **OpenAI Chat Completions**, or appending the entry above to `$DSH_HOME/profiles/web/cordis.patch.yml`, the document that page writes. Adapters re-read it on the next request. See [Configure models](../../docs/user/guide/providers.md) for every field. Either way `NODE_EXTRA_CA_CERTS` still has to be exported by whatever starts `dsh`, because neither surface can carry a CA — and neither can list the plane's live catalog, which the launcher's `MODELS` field does.

## Check

Prove the plane answers before blaming either side of the connection:

```sh
curl --cacert "$HOME/.houdry/server/pki/root_ca.crt" https://127.0.0.1:8080/v1/models
curl --cacert "$HOME/.houdry/server/pki/root_ca.crt" https://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello from Houdry."}]}'
```

On Windows this fails in `curl` for a reason that has nothing to do with the fabric: schannel treats a private CA as untrusted when it cannot reach a revocation list (`CERT_TRUST_REVOCATION_STATUS_UNKNOWN`). Check the plane through the same certificate trust `dsh` uses instead, which is also the assertion that actually matters:

```powershell
$env:NODE_EXTRA_CA_CERTS = "$env:USERPROFILE\.houdry\server\pki\root_ca.crt"
node -e "fetch(process.env.HOUDRY_FABRIC_URL+'/models',{headers:{Authorization:'Bearer '+process.env.HOUDRY_FABRIC_KEY}}).then(r=>r.json()).then(j=>console.log(j.data.map(m=>m.id).join(', ')))"
```

`/v1/models` lists `auto` plus the models present on READY, BUSY or DRAINING workers, falling back to the plane host's local Ollama catalog while no GPU worker is registered, so it is live inventory rather than a fixed catalog. Then select **houdry / auto** in the model picker and send a message.

To exercise the resolver and the whole path without a `dsh` session:

```sh
node integrations/houdry-fabric/resolve.mjs --json    # what it found, and why
sh       integrations/houdry-fabric/start.sh --port 9000
pnpm run test:houdry-fabric                           # 107 node --test assertions, no network required
```

## Tests

`pnpm run test:houdry-fabric` runs the five suites under [`tests/`](tests/) with `node --test`, the same convention as `test:approval-policy`, and is wired into `check-all`. They need no plane: [`tests/fixtures.mjs`](tests/fixtures.mjs) builds throwaway CAs, control-plane identity documents and a real mDNS answer packet, and every request the connection code makes is injected. They cover the UDP and mDNS parsers, the dedupe and name-collapse rankings, the origin derivation a live browse once skipped, the pin store's reuse/rotation/transient/local-root branches, the credential placeholder rule, both fabric error shapes, the fail-before-launch codes, the overlay's model expression and the `DSH_CMD` tokenizer. [`tests/credential.test.mjs`](tests/credential.test.mjs) runs against a throwaway harness home and asserts the persistence above with the product's own parser: exported-over-stored precedence, a token stored only once it authenticated, neither placeholder nor short value stored, no ladder-chosen pin recorded, a document this build cannot read left byte for byte, the copy a refusal names, and one real launcher run that exits 2 with an empty stdout and no secret on stderr.

Two things they cannot do, stated so nobody reads a green suite as live proof:

- Repository lint never sees this code. [`.oxlintrc.json`](../../.oxlintrc.json) lists `**/*.mjs` and `**/*.js` in `ignorePatterns`, so `pnpm lint` passes over every file in this directory.
- Vitest never runs them. No vitest config includes `integrations/**`, which is why these are `node --test` files with their own script rather than `.test.ts`.

## Limits

- **mDNS is unit-tested, not live-observed.** The browse sends a real PTR query and parses SRV/ A / AAAA / TXT answers built by the fixtures, but on the machine this integration was verified on it returned no answers — nothing advertised `_houdry._tcp.local` — so its interoperation with a fabric build that advertises over mDNS has not been demonstrated on the wire. UDP discovery was.
- **Ambiguous multi-plane is unit-tested, not live-observed.** Two planes reporting different names refuse to choose, and that branch is covered by a fake browse. It cannot be produced on one host: a single process owns UDP `41808`, and `houdry serve` answers on every local address with one name, which is the collapse case instead.
- **Multi-turn tool use needs a registered worker.** The plane's local path collapses history into text-only `user`/`assistant`/`system` turns, so `tool` results and assistant `tool_calls` do not survive a round trip; the cluster path forwards the full message array including `tool_call_id`. For a session that reads files or runs commands, keep at least one node READY.
- **`auto` can queue forever on a GPU too small for its pick.** The router sizes each candidate and requires the node to hold it; when its choice exceeds the free VRAM of every registered node, the job stays `queued` and `POST /v1/chat/completions` never returns, so `dsh` appears to hang with no error. Measured on a 4 GiB node: `auto` chose `qwen2.5-coder:7b` at a 6 GiB requirement and twelve jobs piled up queued. Pin a model ref that fits — `houdry job list --json` shows each queued job's `requirements.min_vram_bytes`, which is where you can read the requirement you have to stay under.
- **A pinned model has to be listed in the route.** `models` gates what the picker and `agent-default-model` accept, so a worker ref the plane will serve but the route omits cannot be selected. The launcher lists the plane's catalog before boot, which covers this when you use one; add concrete ids to `models` when you do not.
- **Small models derail on the agent's tool catalog.** `dsh` sends a system prompt and tool list far larger than a 1–2B model can act in; a measured turn on `qwen2.5-coder:1.5b` answered a one-sentence request by inventing `get_goal` / `update_goal` calls, which `dsh` then executed. The transport was correct and the session behaved as configured; the model could not. Size the pinned model to the harness prompt, not to a chat demo.
- **The cluster path streams after completion.** A routed job buffers the answer, then emits SSE chunks; the local path streams tokens live.
- **HTTP/1.1 only.** The plane disables HTTP/2 on its TLS listener.
- **Router picks are heuristic**, so `auto` can choose differently between turns of one session; pin a model ref when a session must hold one.
- **Discovery needs the plane's ports open inbound.** `houdry serve` asks Windows to allow its TCP port and UDP `41808`; run without elevation it prints the `netsh` command it could not apply and continues to serve loopback only, so a LAN peer never hears the probe. `HOUDRY_FABRIC_URL` is the workaround for a plane you can reach but not discover.
- **The route reads its environment at boot.** `!!js` expressions are interpolated when the profile loads, so a plane that moves — new address, new CA, new token — needs `dsh` restarted, not just a new message.
- **`dsh` is a developer preview.** This route was written against 0.2.1-alpha.3. If a newer build rejects it, re-read [Configure models](../../docs/user/guide/providers.md) and [`packages/llm/llm-pi-ai/src/config.ts`](../../packages/llm/llm-pi-ai/src/config.ts): protocol ids and the `compat` set are validated there and are the authority.

## Measured

Against a plane on port `18081` (`serve --data` with `--token`) and one RTX 2050 node. The `dsh` rows ran through `start.sh` with `DSH_CMD='pnpm dsh'`; `start.ps1` was driven against a stub command line, because its only difference from `start.sh` is how it reads the same resolver output. The credential rows ran against a second plane started for that purpose on `18082`, with `$DSH_HOME` and `HOUDRY_FABRIC_TOFU_DIR` pointed at throwaway directories, so no operator's credential document held anything they wrote. The Models page row is the state the settings dialog reported for a `dsh web` whose process environment carried no token; a screenshot of it was not capturable on that host.

| Check | Result |
|---|---|
| `GET /v1/models` without a token | `401` |
| `GET /v1/models` with the token | `200`, 10 ids — `auto` plus 9 live worker refs |
| `POST /v1/chat/completions`, `model: auto` | `200` in 2.0s, `model` field `tinyllama:latest` |
| `houdry discover` vs `resolve.mjs` on the same plane | both find it over UDP; `resolve.mjs` collapses the 3 answering addresses to the 1 plane it reports |
| Plane advertising `auth` with no `HOUDRY_FABRIC_KEY` | exit 2 naming the address and the token to export — before `dsh` boots, not as a `401` inside a session |
| Token stored, then relaunched with an empty environment | exit 0 on the saved address, `URL`/`CA`/`MODELS`/`ARG` printed, no `KEY`, stderr silent, the document unchanged |
| A different token exported over a stored one the plane accepts | exit 2 naming `HOUDRY_FABRIC_KEY` as the copy that lost; the stored token left exactly as written |
| A stored token the plane rejects, nothing exported | exit 2 naming the credential document and stating it was left unchanged; nothing new written |
| `--no-save` against a plane that authenticates | exit 0, neither the credential document nor `fabric-connection.json` created |
| `dsh web` booted with the token only in the credential document | Settings → Models reported Houdry Fabric's key as configured, and the picker held the route's `auto` |
| Every run above, checked for the token | absent from stdout and stderr, and from `--json`'s `exportKey` and `config` |
| A foreign CA installed as the pin | exit 2, no route printed, message names the pin file and `--repin` |
| `--repin`, then `HOUDRY_FABRIC_REPIN=1` | re-pinned twice; each pin DER-identical to the plane's `root_ca.crt`, fingerprint moved `b4df05c7…` → `460374e7…` across a rebuilt PKI |
| Launcher with `DSH_CMD` pointed at a stub | `NODE_EXTRA_CA_CERTS`, `HOUDRY_FABRIC_URL`, `HOUDRY_FABRIC_MODELS` set for the child, `web --patch <overlay>` passed through, a quoted path with a space kept as one argument, an exported key left untouched |
| `dsh headless` with this overlay | session recorded `provider: houdry`, `model: qwen2.5-coder:1.5b`, `contextWindow: 8192`; four successive steps round-tripped `tool_calls` and their results; exit 0 |
| `dsh headless` through the discovered address and pinned CA | exit 0; the plane's job log records the turns as succeeded |
| `dsh web` through `start.sh`, with `DSH_CMD='pnpm dsh'` | the model picker listed all 10 ids the resolver had just printed; a turn on `qwen2.5-coder:1.5b` completed in 5s and the usage popover read `houdry/qwen2.5-coder:1.5b` over `~61 / 8.2K` |
| The overlay's `!!js` model expression | a ref present in `HOUDRY_FABRIC_MODELS` was selectable; one absent reached pi-ai as `UNKNOWN_MODEL`, which is what makes the injected catalog observable at all |

The `contextWindow: 8192` in that session record, and the `~61 / 8.2K` in the web popover, are the evidence that the overlay reached the adapter: 8,192 is this route's `defaultContextWindow`, not pi-ai's 262,144 default. `auto` was not usable from `dsh` on this node for the VRAM reason above, so every completed `dsh` turn pinned a model. The web turn finished in 5s and ignored its instruction — asked for two words it answered with an apology — which is the small-model limit above rather than a transport failure: the same pinned ref answered a plain `POST /v1/chat/completions` correctly one minute later, so the plane served both.

The mDNS and ambiguous-multi-plane rows above are absent on purpose; see [Limits](#limits).
