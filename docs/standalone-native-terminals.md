# 独立原生 Session 接入

当前源码已连接独立 Session 的准备、建立、取消、观察，以及终端清单、选项、显式恢复、创建/关闭、回执和 PTY 输入/输出；设置界面和服务端分页会话目录也已接入。服务端原创建/关闭记录与只核对回执恢复也已接入源码。`ready` 只表示观察到原持久 Session，不表示终端进程已启动或 CLI 已登录。

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

此读取不会恢复 Agent、创建 Session 或终端，也不表示 CLI 已登录。独立终端操作已接入源码，PTY 数据流已接入源码，已连接设置界面，已连接服务端分页会话目录；原生能力缺失会返回不可用，不伪造空清单。

## 终端选项与显式恢复

`GET /v1/standalone-terminals/admissions/:requestId/terminals/options` 读取原生已加载 Agent 的 shell、cwd、尺寸限制及清单。读取失败不会自动恢复 Agent。

`POST /v1/standalone-terminals/admissions/:requestId/terminals/recover` 接受空对象和请求键，由用户显式调用原终端恢复路径。它只解析已确认的持久 Session，不创建缺失 Session、终端或提交提示词/CLI 命令；沿用原 SDK 的 Agent 恢复行为。缺失、忙碌或无法核对身份时返回不可用，不创建替代 Session。恢复期间断开或超时不会触发自动重试；后续可先重读选项。

两条路径都需要当前账户、已配置工作区和 ready admission，Host 在操作前后验证 profile、目录、Session header、注册表及终端 controller，Gateway 返回前重读 admission。创建/关闭及命令回执已接入源码，PTY 输入/输出已接入源码，设置界面已接入，服务端分页会话目录也已接入源码。

## 创建、关闭与原操作回执

`POST .../:requestId/terminals/commands` 使用既有 `TerminalCommand`：创建要求列数至少 2，关闭固定原 terminal_id。请求键必须等于原 command.request_id；命令携带从原生选项读取的 host_instance。不会自动恢复 Agent 或新建 Session。

Gateway 在发送前持久保存 owner、admission、原命令及状态摘要；Host 在原生终端操作前经内部认证通道领取一次派发资格，并再次核对原 Session。重复公开请求不再次派发，重复原生请求只有原回执读取资格。断连、超时及派发后身份变化保留未知，不改写为确定失败。

`POST .../:requestId/terminals/commands/:commandId/reconcile` 接收原命令，只核对原持久记录与原生回执。未派发请求返回 not_admitted；已派发请求不能因此获得再次执行资格。原生重启或内存回执淘汰后仍为未知，不能根据当前终端清单猜测命令成功。

`POST .../:requestId/terminals/commands/:commandId/end-wait` 接收原命令，保存不可改写的等待结束结果。它阻止同一请求以后派发，不取消已经获准或正在执行的命令，也不关闭终端；结束等待后可读取清单了解实际终端状态。已保存的最终结果优先，后到结果不覆盖它。

上述路径仍须账户、工作区、ready admission、CSRF 和匹配的请求键。数据库安装源码已补齐，本次没有实际执行 SQL、原生终端或测试；PTY 接入已连接源码，设置界面已接入，服务端分页会话目录也已接入源码。

## 原生输出与输入

`POST .../:requestId/terminals/:terminalId/attach` 使用既有 TerminalAttachment，沿用真实 Remote Peer、retention hold、队列、背压和断连清理。请求键必须等于 attachment_id；首帧固定原 Session、终端、host_instance 和 attachment_id，之后发送原 snapshot/output/state/ack 帧。本地代理直接转发 NDJSON，不把整条无限输出读入内存。

Host 在接入前后核对持久 Session 身份，并在持续输出时核对原 profile、物理目录、Agent/Session 注册表、header 及终端 controller；连接结束或身份不符时释放原资源。没有自动恢复 Agent、创建终端或发送命令。

`POST .../:requestId/terminals/:terminalId/attachments/:attachmentId/input` 沿用原 host_instance、attachment、窗口限制及严格递增 sequence；write/resize 进入原有有界队列。queued 只表示已入队，执行结果须等待原生 ack/refusal。输入不保存到命令回执，不自动重放；入队后响应或身份不确定时保留未知。

Gateway 返回前复核原 admission，输入有 10 秒请求界限，接入首帧沿用 30 秒界限。两条路径均使用原账户/CSRF 与 transient route 权限；终端故障日志只保留错误码。设置界面已接入，服务端分页会话目录也已接入源码，实际运行行为尚未验证。

## 设置中的独立终端入口

提供方登录终端设置内新增独立会话入口，使用既有可读写工作区列表。准备新请求前先将 request_id/workspace_id 写入当前账户作用域的 sessionStorage；保存失败不发请求。准备只核对原生配置，随后须显式建立原 Session。未启动请求可取消，已派发或未知请求只能观察原结果，不自动重放创建。

已确认 Session 复用原 TerminalPanel/NativeTerminalView、终端 assets、输入队列、命令回执、原请求核对和结束等待。独立路径以 admission ID 绑定，原会话路径和原记录键保持不变。命令在发送前保留于原账户作用域的请求记录，重载优先显示未确认操作；输入保护合并原会话与独立终端，避免一方清除另一方的待确认状态。提供方命令仍须显式发送，不根据界面或命令文本推断登录成功。

本地列表只保留本标签页最多 64 个请求身份；另有服务端分页目录用于在关闭标签页后重新发现已保存会话。移除已确认的本地引用不删除服务端 Session，未确认命令或无法读取的命令记录仍阻止清理。原命令可从服务端目录显式恢复并只核对回执；完整 StandaloneShell 的项目及提供方关联范围仍需对照原实现。未运行浏览器、构建、类型检查或测试。

## 服务端会话目录与本地记录清理

`GET /v1/standalone-terminals/admissions?before_request_id=...` 仅列出当前账户及 Gateway 当前已配置工作区内的持久 admission。按创建时间倒序、相同时间按 request_id 倒序，每页最多 50 项；游标必须来自同一账户和工作区范围，读取边界与页面在同一只读事务中完成。无效或已失效游标需要回到首页，不跨账户查找。索引安装源码已更新，本次未执行数据库安装逻辑。

设置目录支持分页、刷新和打开原会话控件。打开前保留原请求身份并重新读取同一请求，不自动建立或恢复 Session。关闭旧标签页后可从目录重新选择同一持久 Session；目录状态只代表 admission，不代表当前终端进程、命令回执或登录状态。

移除本标签页记录只操作本地引用。清理前要求已读取原 admission、没有待确认输入，并同步核对原命令记录；命令未确认或记录损坏时保留，不丢弃恢复线索。服务端记录和原生终端保持保留，可从目录重新打开。未成功保存到服务端的原请求仍需保留，不能清理。

目录不能代替原终端命令回执：命令原文目前仍由当前标签页记录保留。服务端原命令目录与跨标签页恢复已接入源码，继续沿用原请求身份和未知结果边界。

## 原操作目录与只核对恢复

`GET /v1/standalone-terminals/admissions/:requestId/terminals/commands?before_request_id=...` 在同一只读事务内核对当前账户、工作区及 ready admission，分页列出原创建/关闭命令。每页最多 50 项，以创建时间和 request_id 稳定排序；游标不能跨账户或 admission。返回前校验原命令 JSON、摘要、admission 状态及最终回执身份。仅返回操作参数与持久回执状态，不传输终端输入或历史清单。领取原生派发资格的时间不证明操作已经执行或完成。

设置内可打开原操作记录并显式恢复同一请求。恢复会先原子保存原 path/key/body，以及持久的 recovery_only 标记，再重新挂载既有回执控件；不会自动提交。已存在不同未确认请求时拒绝覆盖，待确认输入也会阻止切换。分页和刷新只读，不会重发操作。

恢复标记在重载、保存和结束等待中保留。原回执读取若返回 not_admitted，恢复请求仍保留并停止，不进入原先用于新请求的首次执行分支。原生重启、回执淘汰或服务端记录不可用都不能授权重放；用户可显式核对或保留未知并结束等待。已完成、拒绝或等待结束的最终回执沿用原不可改写结果。

本次补充命令目录索引安装源码及 API/type/proxy 声明，未执行 SQL、原生终端、浏览器或测试。下一步继续对照原 StandaloneShell 与 ProviderLoginModal 的项目绑定、提供方关联和过程完成范围；整体吸收仍未完成。

## 选择已有项目

设置使用既有账户项目目录选择可选 project_id；不接收浏览器目录或 preset。项目关联与 admission 在同一事务中保存，关联不可改写或删除；同一请求不能切换项目。项目 ID 进入新记录的状态摘要与原生配置摘要。旧工作区记录不增加空项目字段，保留原摘要和恢复路径。

Host 的 standaloneTerminalWorkspaces 可额外包含 project_id，例如 `{ "workspace_id": "default", "project_id": "project-<原项目ID>", "cwd": "E:/codex/project", "agent_preset": "jot-general" }`。同一工作区可配置不同项目，各自绑定 Host 本机已存在的真实目录。项目路径来自操作方映射，不使用 Gateway 的项目 blob 存储目录，也不回退到工作区默认目录。项目绑定要求原 nativeWorkspaceAdmission 配置为 true，沿用原启动前存储/Agent admission hooks。

准备、Session/终端派发资格及原生操作前会重新核对原项目归属和现有工作区预留；删除项目或原预留持有时不取得新执行资格。原历史 admission/命令记录仍可读取，未知结果和结束等待不会因项目状态变化被丢弃。归档策略沿用原 ProjectRepository.assertOwned，不另授目录访问权。

有原生尝试记录的独立 Session 会作为 standalone_terminal 成员进入原项目维护清单，不创建虚构对话或 run；它没有 conversation scopes。未取得原生资格的准备/取消身份不会伪装成活跃 Session，之后的创建仍受项目预留与原 SDK admission hooks 阻挡。跨 owner/project 或双重用途别名保持拒绝。

原工厂持有 Session namespace 时，Jot 终端的借用、输入和操作检查会拒绝该身份。原生维护屏障还会核对同一终端 controller/control、在途调用以及 SDK 保留资源清单；清理失败、保留屏幕或正在创建/关闭的终端均不视为静止。正常维护前应通过原控件关闭相关终端；已有维护预留先通过原操作控制处理。该边界覆盖已登记的 Jot Session/终端，不表示操作系统其他程序被隔离。

上述实现依据本地固定版本 SDK 源码中 create/close 等待分配和清理、list 包含未清理 allocations 的行为。本次仅阅读源码并修改开发分支，没有执行 SDK、数据库安装、终端、浏览器或测试。提供方关联和过程完成接口仍需继续对照原实现。
