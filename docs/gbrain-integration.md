# GBrain 对接说明

本文档说明 `perseng-cli` 如何对接外部 GBrain 服务，包括：

- 需要配置哪些环境变量
- 程序会在什么时机自动调用 GBrain
- 如何手工验证 `search / think / capture`
- 现有 HTTP 接口约定是什么
- 常见失败场景怎么排查

## 1. 当前集成形态

项目当前已经内置了 GBrain HTTP 客户端，不需要再写额外插件。

接入分成两类：

- 自动接入：`run` / `serve` / 飞书机器人在任务执行前后自动调用 GBrain
- 手工接入：通过 `tool://gbrain` 主动执行 `search / think / capture`

## 2. 环境变量

最小配置如下：

```env
GBRAIN_URL=http://your-gbrain-host
GBRAIN_HTTP_TOKEN=your_token
GBRAIN_BRAIN_AREA=perseng
GBRAIN_TIMEOUT_MS=15000
```

字段说明：

- `GBRAIN_URL`: GBrain 服务基础地址；未配置时整个 GBrain 功能关闭
- `GBRAIN_HTTP_TOKEN`: Bearer Token，可选
- `GBRAIN_BRAIN_AREA`: 默认脑区，未显式传入时使用，默认值是 `perseng`
- `GBRAIN_TIMEOUT_MS`: 请求超时毫秒数，默认 `15000`

配置项也记录在：

- `docs/configuration.md`

## 3. HTTP 接口约定

当前客户端会向 GBrain 发送 3 个 POST 请求：

- `POST /mcp/v1/search`
- `POST /mcp/v1/think`
- `POST /mcp/v1/ingest`

请求体如下。

### 3.1 search

```json
{
  "query": "如何配置飞书机器人",
  "brain_area": "jiangziya"
}
```

### 3.2 think

```json
{
  "question": "如何配置飞书机器人",
  "brain_area": "jiangziya"
}
```

### 3.3 ingest

```json
{
  "content": "[jiangziya] 用户: 如何配置飞书机器人\n助手: ...",
  "slug": "jiangziya-1710000000000",
  "brain_area": "jiangziya"
}
```

如果配置了 `GBRAIN_HTTP_TOKEN`，请求头会自动带：

```http
Authorization: Bearer <token>
```

## 4. 自动接入链路

### 4.1 `perseng run`

`run` 命令会在真正调用 LLM 之前，先执行一次：

- `gbrainThink({ question: task, brainArea: roleId })`

成功时会把返回的：

- `answer`
- `citations`
- `gap`

注入到 system prompt 中。

任务完成后，如果有正常输出，还会异步执行：

- `gbrainCapture({ content, slug, brainArea: roleId })`

注意：

- GBrain 失败不会阻断主流程
- 未配置 `GBRAIN_URL` 时，项目会直接跳过 GBrain

### 4.2 `perseng serve`

`serve` 模式的处理逻辑与 `run` 基本一致：

- 执行前先 `think`
- 执行后异步 `capture`
- 使用当前任务角色作为 `brainArea`

### 4.3 飞书机器人

飞书消息进入后，也会先做一次：

- `gbrainThink({ question: msg.text, brainArea: session.roleId })`

然后把结果带入本轮任务上下文。

助手回复成功后，再异步执行：

- `gbrainCapture({ content, slug, brainArea: session.roleId })`

这意味着当前实现里，GBrain 的脑区通常会和角色 ID 对齐，例如：

- `jiangziya`
- `nuwa`
- `luban`

## 5. GBrain 结果如何进入提示词

GBrain 结果不是直接展示给最终用户，而是先被注入 prompt。

当前 prompt builder 会把它组织成两段：

- `## Brain 检索`
- `## Brain 差距`

其中：

- `answer` 和 `citations` 进入 `Brain 检索`
- `gap` 进入 `Brain 差距`

这使得模型在正式回答前，先拿到一份来自 GBrain 的外部知识补充。

## 6. 手工验证方式

### 6.1 查看工具手册

先确认 `tool://gbrain` 已出现：

```bash
node bin/perseng.js toolx discover
node bin/perseng.js toolx manual --tool tool://gbrain
```

注意：

- `tool://gbrain` 只有在配置了 `GBRAIN_URL` 后才会可见

### 6.2 推荐优先用 `toolx exec`

当前 CLI 已支持直接透传 GBrain 所需的关键参数：

- `--query`
- `--question`
- `--brainArea`
- `--slug`

因此常见操作可以直接这样执行。

### 6.3 手工执行 `search`

```bash
node bin/perseng.js toolx exec --tool tool://gbrain --action search --query "如何配置飞书机器人" --brainArea jiangziya
```

### 6.4 手工执行 `think`

```bash
node bin/perseng.js toolx exec --tool tool://gbrain --action think --question "如何配置飞书机器人" --brainArea jiangziya
```

### 6.5 手工执行 `capture`

```bash
node bin/perseng.js toolx exec --tool tool://gbrain --action capture --content "这是一条测试知识" --slug manual-test --brainArea jiangziya
```

### 6.6 复杂参数场景仍可用 `toolx run --yaml`

如果你想完整传递一段 ToolX 票据，或者要做自动化脚本拼装，也可以继续使用：

```bash
node bin/perseng.js toolx run --yaml "{\"tool\":\"tool://gbrain\",\"mode\":\"execute\",\"parameters\":{\"action\":\"search\",\"query\":\"如何配置飞书机器人\",\"brainArea\":\"jiangziya\"}}"
```

### 6.7 通用参数透传

除了显式参数外，`toolx exec` / `toolx dryrun` 现在还支持两种通用透传方式：

- `--param key=value`
- `--params-json '{"key":"value"}'`

适合这些场景：

- ToolX 协议层已经支持新字段，但 CLI 还没有专门的显式参数
- 你在脚本里动态拼装参数
- 你想传对象、数组、布尔值、数字

示例：

```bash
node bin/perseng.js toolx exec --tool tool://gbrain --action search --param query=如何配置飞书机器人 brainArea=jiangziya
```

```bash
node bin/perseng.js toolx exec --tool tool://gbrain --action think --params-json "{\"question\":\"如何配置飞书机器人\",\"brainArea\":\"jiangziya\"}"
```

优先级说明：

- 显式参数最高
- `--param key=value` 次之
- `--params-json` 最低

## 7. 最小联调步骤

推荐按这个顺序联调：

1. 配好 `GBRAIN_URL`
2. 运行 `node bin/perseng.js doctor --show-config-sources`
3. 执行一次 `toolx discover`，确认 `tool://gbrain` 已出现
4. 手工执行一次 `think`
5. 再执行 `node bin/perseng.js run "你的问题"`
6. 对比未开启 GBrain 时的输出差异

## 8. 常见问题

### 8.1 为什么配置了 GBrain，但工具没出现

优先检查：

- `GBRAIN_URL` 是否真的生效
- `.env` 是否放在 `perseng-cli/` 根目录
- 是否用 `doctor --show-config-sources` 看过最终配置来源

### 8.2 GBrain 请求失败会不会让主任务失败

不会。

当前实现是“可选增强”：

- `think` 失败时降级为无结果
- `capture` 失败时忽略，不阻断最终输出

### 8.3 为什么我设置了 `GBRAIN_BRAIN_AREA`，但实际脑区像是角色名

因为自动链路里通常会显式传入 `brainArea: roleId` 或 `session.roleId`。

也就是说：

- 自动链路优先使用当前角色 ID
- `GBRAIN_BRAIN_AREA` 主要用于没有显式传参的场景

### 8.4 我能不能只接 `search`，不用 `capture`

可以。

是否执行 `capture` 由程序逻辑决定，但即使开启了自动捕获，失败也不会阻断主流程。

如果你要做更细粒度开关，建议后续补一个显式配置项，而不是依赖异常来关闭。

### 8.5 怎么确认请求真的打到 GBrain 了

可以从这几个方向验证：

- 看 GBrain 服务端日志
- 把 `GBRAIN_URL` 故意改错，确认 `tool://gbrain` 返回错误
- 用 `toolx run --yaml` 单独执行一次 `think`

## 9. 相关代码

- GBrain 客户端：`src/toolx/gbrain-client.js`
- ToolX 声明：`src/toolx/ToolXProtocol.js`
- CLI 自动接入：`src/commands/run.js`
- 守护模式自动接入：`src/commands/serve.js`
- 飞书自动接入：`src/feishu-bot-runner.js`
- Prompt 注入：`src/prompt-builder.js`
