---
kind: upgrade-guide
description: "Houdry Fabric 不再接受 overlay 或 HOUDRY_FABRIC_MODELS 配置。"
---

# Houdry Fabric 改用受监视的 profile 路由

[English](guide.md) | 中文

## 变更

Fabric 启动脚本不再通过 `houdry-fabric.overlay.yml` 启动 `dsh web`，也不再读取或导出 `HOUDRY_FABRIC_MODELS`。它会把解析出的地址和实时目录写入 `$DSH_HOME/profiles/web/cordis.patch.yml`，并在 Web UI 运行时持续更新该 `houdry` 路由。直接调用已移除 overlay 或依赖环境模型列表的用户必须迁移。

## 迁移

1. 使用 `sh integrations/houdry-fabric/start.sh` 或 `powershell.exe -File integrations/houdry-fabric/start.ps1` 启动 Web UI；不要传入 `--patch integrations/houdry-fabric/houdry-fabric.overlay.yml`。
2. 从 shell profile、服务定义和启动包装脚本中移除 `HOUDRY_FABRIC_MODELS`。监视器会读取 `GET /v1/models`，并把可用模型写入 Web profile 路由。
3. 仅在选择特定控制面时保留 `HOUDRY_FABRIC_URL`。按凭据和 TLS 信任需要保留 `HOUDRY_FABRIC_KEY` 与 `NODE_EXTRA_CA_CERTS`。
4. 在 Web 模型选择器中打开 `houdry` 提供商。改变 Fabric 目录并最多等待 15 秒，确认模型选择器无需重启 Web UI 即会刷新。
