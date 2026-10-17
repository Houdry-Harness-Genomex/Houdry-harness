---
kind: upgrade-guide
description: "Houdry Fabric no longer accepts the overlay or HOUDRY_FABRIC_MODELS configuration."
---

# Houdry Fabric uses a watched profile route

English | [中文](guide.zh.md)

## Change

The Fabric launcher no longer starts `dsh web` with `houdry-fabric.overlay.yml` and no longer reads or exports `HOUDRY_FABRIC_MODELS`. It writes the resolved address and live catalog to `$DSH_HOME/profiles/web/cordis.patch.yml`, then keeps that `houdry` route current while the Web UI runs. Users who invoke the removed overlay directly or depend on an environment model list must migrate.

## Migration

1. Start the Web UI with `sh integrations/houdry-fabric/start.sh` or `powershell.exe -File integrations/houdry-fabric/start.ps1`; do not pass `--patch integrations/houdry-fabric/houdry-fabric.overlay.yml`.
2. Remove `HOUDRY_FABRIC_MODELS` from shell profiles, service definitions, and launcher wrappers. The watcher reads `GET /v1/models` and writes the available models into the Web profile route.
3. Keep `HOUDRY_FABRIC_URL` only when selecting a specific control plane. Keep `HOUDRY_FABRIC_KEY` and `NODE_EXTRA_CA_CERTS` as needed for credentials and TLS trust.
4. Open the `houdry` provider in the Web model picker. Change the Fabric catalog and wait up to 15 seconds to confirm that the picker refreshes without a Web UI restart.
