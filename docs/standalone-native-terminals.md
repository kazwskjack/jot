# 独立原生 Session 接入

当前源码已连接 Gateway 的准备、读取、派发、取消、观察流程与原生 Host 的身份、创建、只读观察实现。已确认独立 Session 的终端清单也已接入源码；独立终端的 shell/尺寸选项和显式恢复已接入源码；创建/关闭操作、PTY stream 和产品界面尚未接通；`ready` 只表示观察到原持久 Session，不表示终端进程已启动或 CLI 已登录。

## 显式配置

Gateway 使用既有 `GENERAL_AGENT_SESSION_ADAPTER_URL`、`GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE` 和内部服务通道。增加 `GENERAL_AGENT_STANDALONE_TERMINALS_ENABLED=true` 才会启用新客户端；原生 adapter 和 Gateway 的内部通道必须对应同一 Gateway，内部 token 至少 32 个字符。未配置客户端时，准备/派发返回不可用。

在既有 jot-session-adapter 配置对象中声明 Host 本地工作区。目录必须已存在，使用当前 Host 平台的绝对路径。例如 Windows Host：

```json
{
  "standaloneTerminalWorkspaces": [
    {"workspace_id":"default","cwd":"E:/codex/workspace","agent_preset":"jot-general"}
  ]
}
```

Linux Host 使用它本机的绝对目录。工作区 ID 必须同时在 Gateway 的既有工作区列表内。只接受原 general preset，不能选 budgeted work preset；缺少目录、原生 inspect/resolve/create 能力或内部回执通道会拒绝接入。目录、preset 和 profile 来自操作方配置，公开 API 不接收这些权限字段。

## 身份与派发

1. Gateway 固定当前账户、工作区、请求 ID、原生配置摘要及服务端 Session ID，不创建模型 run。
2. 显式派发重新核对配置，以版本和状态摘要领取持久派发资格。
3. Host 经既有 bearer 通道核对真实 profile、目录物理身份和原请求摘要，再经内部通道领取一次原生创建资格。
4. 原生创建资格写入独立、不可更新的尝试记录后才允许调用原 SDK。重复请求只有只读观察资格。
5. 已存在 Session 只观察，不在这里恢复 Agent 或激活待处理 inbox。新建仅在原 SDK 明确报告不存在、注册表为空、目录与 preset 一致时进入共享创建路径。
6. 超时、断连和无法核对的结果保持未知；观察不会重放创建。所有原生身份确认仍须来自已认证通道，持久摘要本身不是授权。

本次开发没有运行产品、数据库安装逻辑、原生 Session、CLI 或测试，也没有更改部署环境。

## 独立终端清单

`GET /v1/standalone-terminals/admissions/:requestId/terminals` 只读取当前账户、当前配置工作区内已达到 ready 的独立 Session。Host 在读取原生终端 controller 前后核对持久 Session 身份及原确认摘要，Gateway 返回前复核 admission 状态。响应沿用既有 TerminalInventory 公共字段，不含终端输出或私有日志。

此读取不会恢复 Agent、创建 Session 或终端，也不表示 CLI 已登录。尚未完成独立终端操作、PTY 数据流及界面；原生能力缺失会返回不可用，不伪造空清单。

## 终端选项与显式恢复

`GET /v1/standalone-terminals/admissions/:requestId/terminals/options` 读取原生已加载 Agent 的 shell、cwd、尺寸限制及清单。读取失败不会自动恢复 Agent。

`POST /v1/standalone-terminals/admissions/:requestId/terminals/recover` 接受空对象和请求键，由用户显式调用原终端恢复路径。它只解析已确认的持久 Session，不创建缺失 Session、终端或提交提示词/CLI 命令；沿用原 SDK 的 Agent 恢复行为。缺失、忙碌或无法核对身份时返回不可用，不创建替代 Session。恢复期间断开或超时不会触发自动重试；后续可先重读选项。

两条路径都需要当前账户、已配置工作区和 ready admission，Host 在操作前后验证 profile、目录、Session header、注册表及终端 controller，Gateway 返回前重读 admission。完整命令回执、创建/关闭、PTY 输入/输出及界面仍待接入。
