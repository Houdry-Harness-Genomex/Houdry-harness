# Houdry Fabric Provider

[English](houdry-fabric.md) | 中文

把 DeepSeek Harness 连接到 [Houdry](https://github.com/houdry-genomex/houdry)——一个私有 GPU fabric，会把推理（inference）请求路由到你组织内部的 GPU 资源。

## Houdry 是什么？

Houdry 是一个主权 AI 执行平台，把计算、模型和数据都留在你自己的基础设施里。它会：

- 在你组织的机器上发现 GPU
- 把它们组成受管理的集群
- 把推理请求路由到可用资源
- 提供 OpenAI 兼容 API

DeepSeek Harness 把 Houdry 当作模型后端使用，与连接 OpenAI、Anthropic 或本地 Ollama 的方式相同。

## 架构

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

## 安装与配置

### 1. 安装并启动 Houdry fabric

在控制面机器上：

```bash
curl -fsSL https://github.com/houdry-genomex/houdry/releases/latest/download/install.sh | sh
export PATH="$HOME/.houdry/bin:$PATH"
houdry serve --listen 0.0.0.0:8080
```

### 2. 添加 GPU worker

在每台 GPU 机器上：

```bash
houdry gpu detect
houdry gpu register
```

worker 会通过局域网找到控制面，并持续运行。

### 3. 让 DeepSeek Harness 连接 fabric 启动

本仓库的 [Houdry fabric 集成](../../integrations/houdry-fabric/INTEGRATION.md)会解析控制面、它的证书、凭据和实时目录，把提供方写入 Web profile 的受监视补丁文档，再以会话监视器启动 Web UI。

```sh
sh integrations/houdry-fabric/start.sh                # POSIX shells
```

```powershell
pwsh integrations/houdry-fabric/start.ps1             # Windows
```

启动脚本会先运行 `node integrations/houdry-fabric/resolve.mjs`。这个解析器做出的四项决定，与 [Houdry Agent](https://github.com/houdry-genomex/houdry-agent) 在自己客户端里做的完全一致，顺序也一致：

| 决定 | 如何得出 |
|---|---|
| 哪个控制面 | 你导出的地址；否则在 UDP `41808` 与 mDNS `_houdry._tcp.local` 上浏览局域网，每个应答都要经 `/.well-known/houdry.json` 确认；再否则采用本机 `18080`、`8090` 或 `8080` 上已在监听的控制面。 |
| 哪个证书 | 你指定的 `HOUDRY_FABRIC_CA`；否则该控制面 origin 已固定的 CA，使用前会再与控制面核对一次；再否则 `~/.houdry/server/pki` 里的根证书；最后才是首次使用时抓取 `/v1/pki/ca`——私有网络之外的主机一律拒绝。 |
| 哪个凭据 | 你导出了 `HOUDRY_FABRIC_KEY` 就用它，否则用上一次被控制面接受的那次启动存下的令牌；两者都没有而控制面声明了 `auth`，会直接中止启动。 |
| 哪些模型 | 立刻向该控制面请求 `GET /v1/models`，模型选择器因此只列出集群此刻真能服务的模型。 |

固定结果保存在 `~/.houdry-dsh`：每个 origin 一条 `houdry-tofu-ca.json` 记录，`cas/` 下每个 origin 一份 PEM，因为 `NODE_EXTRA_CA_CERTS` 只能指定一个文件，而 Node 会把它用于所有主机。

这四项都有答案之前不会启动任何东西。无法联系的控制面、上次固定之后变更过的 CA、索要未导出令牌的控制面、拒绝列出模型的目录，每一种都会以退出码 2 停止，并给出写明地址与文件名的消息——而不是后来表现为一次模型错误。

控制面认下令牌的那次启动会把它留下来。地址记在信任目录里的 `fabric-connection.json`，紧挨着固定结果；令牌写进 `$DSH_HOME/.credentials.yaml`，也就是 `dsh` 读取所有提供方密钥的那份文档——与**设置 → 模型**写入的是同一份。于是空环境重启也能连回那个控制面，密钥仍由 `dsh` 自己解析，令牌不会经启动脚本再传出去。对导出它的那次运行而言，导出的值始终高于保存的值；`--no-save` 让一次启动什么都不记。`dsh headless` 完全不读这份文档，原因见排障一节。

### 4. 或者手工配置提供方

1. 打开设置 → 模型
2. 选择**添加模型提供商**
3. 选择**自定义模型 API**
4. 填写：
   - **名称**：`Houdry Fabric`
   - **API 协议**：`OpenAI Chat Completions`
   - **API 地址**：`https://<fabric-host>:8080/v1`
   - **API 密钥**：（除非 fabric 使用了 `--token`，否则留空）
5. 点击**获取可用模型**
6. 勾选要启用的模型
7. 保存

启动 `dsh` 之前还要信任该控制面的证书颁发机构，因为 `openai-completions` 路由没有 CA 字段，而 Node 只信任内置根证书：

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.houdry/server/pki/root_ca.crt"
npx @deepseek-ai/dsh web
```

用 `serve --data DIR` 启动的控制面把 CA 保存在 `DIR/pki/root_ca.crt`。手工配置的提供方不会被此集成监视，因此地址和模型列表会保持保存时的状态。集成管理的路由会在 Web UI 中刷新模型变化；CA 变更仍需要重启 `dsh`，因为 Node 在进程启动时读取 `NODE_EXTRA_CA_CERTS`。

在那一页保存的密钥写入 `$DSH_HOME/.credentials.yaml`，用的键名是路由指定的引用。fabric 路由指定 `HOUDRY_FABRIC_KEY`，所以通过集成脚本启动时读到的就是你在页面上输入的那一份，不必再要一次。

## 使用

### 模型选择

- **`auto`**：Houdry 的路由器分析你的提示词，选出最合适的模型与 GPU 节点。前提是确有节点装得下它选中的模型——见下面的注意事项。
- **显式模型**（例如 `qwen2.5-coder:1.5b`）：固定到该模型；节点仍由 Houdry 选择

路由器会考虑：

- 提示词的模态（文本、代码、视觉、文档）
- 复杂度（0-100 评分）
- 模型能力（对话、代码、reasoning、视觉、工具）
- GPU 可用性（显存、模型是否已加载）
- 节点状态（READY，而非 BUSY）

如果选中的模型需要的显存超过任何已注册节点能腾出的量，任务会停在 `queued`，请求直到 `--openai-wait` 超时前都不会返回。`houdry job list --json` 会打印每个排队任务的 `requirements.min_vram_bytes`，与 `houdry node list` 对照，就能读出是否装得下。

### Function Calling

使用支持工具调用的模型时，Houdry 支持 OpenAI 风格的 Function Calling。fabric 会把 `tools` 和 `tool_choice` 转发给模型运行时，并返回结构化的 `tool_calls`。

这里有两个条件，都是在 `dsh` 上实测得到的：

- **只有集群路径保留工具 transcript。** 被路由的任务会转发完整消息数组，包括 `tool_call_id`，因此连续步骤能看到自己的结果。控制面的本地回退会把历史折叠成纯文本的 `user`/`assistant`/`system` 轮次，工具调用与结果被丢弃且没有错误。任何使用工具的会话都要保留一个 READY 的 GPU 节点。
- **模型必须足够大，才能装下 harness 提示词。** `dsh` 发出的系统提示词与工具目录远大于聊天演示。在 `qwen2.5-coder:1.5b` 上实测的一次轮次里，模型面对一句普通请求凭空发明了 `get_goal` / `update_goal` 调用。请按 harness 而不是按 API 来选择模型规模。

### 流式输出

支持流式输出。fabric 目前会先缓存完整回复再流式发送（完成后的 SSE）。逐 token 的运行时流式输出仍在计划中。

## 验证

在配置 DeepSeek Harness 之前先测试连通性：

```bash
curl --cacert "$HOME/.houdry/server/pki/root_ca.crt" \
  https://127.0.0.1:8080/v1/models
```

预期：包含 `"id": "auto"` 以及其他可用模型的 JSON 列表。

聊天补全测试：

```bash
curl --cacert "$HOME/.houdry/server/pki/root_ca.crt" \
  https://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 通过 Node 检查控制面

在 Windows 上，`curl` 面对私有 CA 会失败，原因与 fabric 无关：schannel 无法访问吊销列表时会报 `CERT_TRUST_REVOCATION_STATUS_UNKNOWN`。请改用 `dsh` 自身使用的同一套证书信任来检查控制面，这才是真正需要成立的断言：

```powershell
$env:NODE_EXTRA_CA_CERTS = "$env:USERPROFILE\.houdry\server\pki\root_ca.crt"
node -e "fetch(process.env.HOUDRY_FABRIC_URL+'/models',{headers:{Authorization:'Bearer '+process.env.HOUDRY_FABRIC_KEY}}).then(r=>r.json()).then(j=>console.log(j.data.map(m=>m.id).join(', ')))"
```

### 检查 Web UI

`/v1/models` 是实时清单。通过集成启动之后：

1. 打开模型选择器，选择 `houdry` 提供商。
2. 把列表与 `node integrations/houdry-fabric/resolve.mjs --json` 对照，后者打印最初写入受监视 profile 路由的 id。
3. 添加或移除一个已服务的模型，最多等待 15 秒，确认模型选择器在不重启 Web UI 的情况下刷新。
4. 先用 `auto` 发一条消息，再用一个装得下你节点的固定模型发一条，然后在 `houdry job list` 里确认这两次。

监视器会保留由用户管理的 `!!js` Houdry 地址，并停止而不是替换它。手工路由或变更过的 CA 需要合适的显式配置或重启 `dsh`。

## 故障排查

### 证书错误

**症状**：TLS 握手失败，证书无效

**解决**：信任 Houdry 根 CA：

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.houdry/server/pki/root_ca.crt"
```

这必须在 `dsh` 启动前设置好；它在进程启动时读取，而且不存在可按提供方设置的证书字段。

如果你通过集成脚本启动，而控制面的 CA 被重建过——换了新的 `serve --data` 目录，或重新生成了 PKI——启动脚本会停止，而不是信任新证书，因为未经你同意就变化的 CA 正是中间人的样子。确认控制面确实是你以为的那一个，然后用命令行 `--repin` 或环境变量 `HOUDRY_FABRIC_REPIN=1` 重新固定。只有完全无应答的控制面才被视为暂时性故障，保留原有固定并给出一条说明。

### 没有可用模型

**检查**：

- fabric 正在运行：`curl --cacert ~/.houdry/server/pki/root_ca.crt https://127.0.0.1:8080/healthz`
- GPU worker 已注册：`houdry node list --server https://127.0.0.1:8080`
- worker 上有模型：`houdry model list --server https://127.0.0.1:8080`

没有 GPU worker 时，可以在控制面机器上启动本地 Ollama 作为回退。

### 请求超时

**默认超时**：10 分钟

**调大它**：

```bash
houdry serve --openai-wait 15m
```

检查节点状态——BUSY 节点在当前工作完成前不会接受新任务。完全没有开始的任务通常是容量问题：路由器选中的模型需要的显存超过节点拥有的量，于是排队而不是失败。

### 找不到模型

模型在目录里，但任何 worker 都没有拉取：

```bash
# On GPU worker machine
ollama pull tinyllama
```

### 重启后又一次索要令牌

**症状**：昨天还连得上的控制面，启动脚本却以「这个控制面索要令牌，而没有导出或保存任何令牌」停止。

保存的令牌住在 harness 主目录里，所以主目录不是昨天那次启动写入的那一个，这份文档里就没有它：换了用户、换了容器，或者由启动 `dsh` 的那一层设置了 `DSH_HOME`。先检查这个变量。`dsh headless` 从不读这份文档——一次性任务按设计在启动时取得凭据——因此每次都要导出 `HOUDRY_FABRIC_KEY`。用了 `--no-save` 或 `HOUDRY_FABRIC_NO_SAVE` 的启动同样什么都没存。

消息里点名的若是**保存的**令牌，说明控制面应答了并拒绝了文档里那份：它当初用 `serve --token` 启动的值与记住的不同。导出当前值，下一次被控制面接受的启动会替换保存的那份；被拒绝的值从不写入。在**设置 → 模型**里填写密钥是一样的，那一页直接写这份文档。

### 控制面可达却始终发现不了

`houdry serve` 会请求系统放行入站的 UDP `41808` 与它的 TCP 端口。在 Windows 上以非管理员身份运行时，它会打印没能应用的 `netsh` 命令，然后继续只提供回环服务，于是局域网里的对端永远收不到探测。会隔离客户端的访客 SSID 从另一侧阻断同一次浏览。对于可达却无法发现的控制面，`HOUDRY_FABRIC_URL` 就是入口；当网络丢弃组播时，用 `--no-mdns` 把浏览收窄到 UDP。

## 配置参考

### 提供方字段

| 字段 | 值 |
|-------|-------|
| 名称 | `Houdry Fabric`（或自定义） |
| API 协议 | `OpenAI Chat Completions` |
| API 地址 | `https://<host>:8080/v1` |
| API 密钥 | 留空（或 fabric `--token` 的值） |
| TLS 信任 | 设在 `dsh` 进程上的 `NODE_EXTRA_CA_CERTS`；不存在按提供方的证书字段 |

### 环境变量

由 `resolve.mjs` 与其会话监视器读取。启动脚本会把 CA 以及无密钥控制面所需的占位符密钥传给 `dsh`；它们不会导出已解析的 Fabric URL 或模型目录。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `HOUDRY_FABRIC_URL` | 保存的控制面，否则*自动发现* | 直接用这个地址，而不是上次启动记下的那一个，也不是局域网浏览。`HOUDRY_BASE_URL` 作为旧名字同样接受。 |
| `HOUDRY_FABRIC_KEY` | 保存的令牌，否则 `no-key-required` | 控制面 `serve --token` 的值。默认值是占位符，因为 pi-ai 的客户端会拒绝没有凭据的路由。 |
| `HOUDRY_FABRIC_CA` | *首次使用时固定* | 你以其他方式取得的 CA 文件；它优先于固定结果。 |
| `HOUDRY_FABRIC_TOFU_DIR` | `~/.houdry-dsh` | 每个 origin 的固定结果与保存的控制面地址的存放位置。 |
| `HOUDRY_FABRIC_REPIN` | *关闭* | `1`、`true`、`yes` 或 `on` 会为本次启动重新固定 CA。 |
| `HOUDRY_FABRIC_NO_SAVE` | *关闭* | 同样这四个值让本次启动不记录控制面，也不记录它的令牌。 |
| `HOUDRY_FABRIC_INSECURE` | *关闭* | 同样这四个值会跳过证书校验。仅用于本地开发。 |
| `DSH_CMD` | `dsh` | 要启动的命令，按引号切分，例如 `pnpm dsh`。 |

解析器的开关：`--repin`、`--no-save`、`--timeout <ms>`、`--no-mdns`、`--json`。`HOUDRY_OLLAMA` 这类 fabric 侧变量属于 `houdry serve`，不属于这个启动脚本：

```bash
# Override Ollama URL for fabric local fallback (advanced)
export HOUDRY_OLLAMA="http://192.168.1.100:11434"
```

## 安全

- **mTLS**：GPU worker 使用客户端证书。`/v1` API 只要求服务端 TLS。
- **令牌认证**：给 `houdry serve` 传入 `--token` 即可启用 API 密钥认证。把它填进 DeepSeek Harness 的「API 密钥」，或者只导出一次、由控制面认下的那次启动替你存下。无论哪种，保存的位置都是 `$DSH_HOME/.credentials.yaml`：在 0700 目录下以 0600 写入，写入时持有文件锁，内容是可直接还原的明文——以你的用户身份运行的进程能读到它，也没有接入任何系统钥匙串；在 Windows 上保护它的是你账户的所有权，而不是权限位。它从不写入信任目录，从不出现在启动脚本的标准输出上，也从不放进被启动进程的命令行。
- **首次联系**：唯一一次没有既有固定可对照的 CA 抓取是不验证的，因此私有或回环地址范围之外一律拒绝固定，而之后每次运行都会通过已固定的 CA 复核控制面。
- **网络**：把 fabric 留在私有网络里。没有额外认证就不要暴露到公网。

## 链接

- Houdry 仓库： https://github.com/houdry-genomex/houdry
- fabric 文档：[docs/](https://github.com/houdry-genomex/houdry/tree/main/docs)
- OpenAI 兼容 API 规范：[docs/OpenAI-compatible-API.md](https://github.com/houdry-genomex/houdry/blob/main/docs/OpenAI-compatible-API.md)
- Houdry Agent（另一种桌面客户端）： https://github.com/houdry-genomex/houdry-agent
- 集成与解析器：[INTEGRATION.md](../../integrations/houdry-fabric/INTEGRATION.md)
- 每个提供方字段：[配置模型](../user/guide/providers.zh.md)

## 对比：Houdry 与本地 Ollama

| 特性 | 本地 Ollama | Houdry Fabric |
|---------|--------------|---------------|
| 部署 | 单机 | 多节点集群 |
| 路由 | 手工选择模型 | 自动路由（model=auto） |
| GPU 池化 | 一台机器的 GPU | 所有已注册的 GPU 机器 |
| 调度 | 无（一次只处理一个请求） | 队列 + 节点选择 |
| 发现 | localhost:11434 | UDP 与 mDNS 上的局域网浏览，或手工指定 URL |
| 安全 | 无认证 | mTLS（worker）+ 可选令牌（API） |

单机开发用本地 Ollama。当你有多台 GPU 机器、并希望跨它们做路由时再用 Houdry。

## 小结

1. 安装 Houdry fabric：`houdry serve`
2. 注册 GPU worker：`houdry gpu register`
3. 用 `sh integrations/houdry-fabric/start.sh` 启动 Harness，或者在设置里把 Houdry 添加为自定义 OpenAI 提供方并导出 `NODE_EXTRA_CA_CERTS`
4. 用 `model=auto` 发消息，或固定一个装得下你节点的模型

这套集成使用 Houdry 标准的 OpenAI 兼容 `/v1` API——不需要改动 harness 代码。
