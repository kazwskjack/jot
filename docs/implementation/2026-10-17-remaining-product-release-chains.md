# 剩余产品与发布链盘点（9 / 26）

日期：2026-10-17。范围对应 `docs/PILOTDECK-PARITY.md` 中的 checkpoints/artifacts、Git、commands/skills、MCP/plugins/hooks、voice、Web/editors、onboarding/settings、desktop packaging、install/update 共九条。其余十七条由配套盘点覆盖。本文件是源代码审计和可执行拆分，不是九条功能已经交付的声明。

证据范围：阅读当前工作树的入口、实现和测试文件名/测试内容；通过仓库本地 `npm run brain -- list-pages` 与 `read-page native-goal-boundary` 读取现有约束。未运行构建、测试、安装、真实模型、网络、远端 Git 或部署。既有测试文件的存在仅说明可复用的验证入口，不表示本次执行通过。未下载或逐行审计 PilotDeck；上游入口取自本仓库已固定的参考清单。检索不到入口的结论限于本次检查的公开仓库，不代表另行安装的 DSH 没有这些能力。

## 共同边界

- `src/` 是可独立运行的本地产品，`packages/gateway/` 是另一套身份、数据库与执行契约。新界面必须说明所连后端，不能把本地演示能力冒充 Gateway 能力。
- DSH 保持原生规划、Session、Goal 与工具权限；Gateway 保持 owner、权限、版本、租约、预算、幂等与正式交付。不得为缺失的管理功能另建 Agent planner，或将读取/加载/快照视为执行权限。
- 新写操作使用既有 owner 解析、CSRF/origin、`atomicCommand`/事务、版本前置条件与不可变回执；结果未知保留原请求，不能用新请求重试外部副作用。账户与凭证不进入响应、日志和公开仓库。
- 本地可实现的代码、假后端验证、错误恢复、浏览器交互与打包配置可自主推进。真实账户、麦克风/OS 权限、签名与发布凭证、真实 provider、远端推送、生产切换及部署验收属于操作者实机验收；这不阻止前面的实现工作。
- PilotDeck 参考固定为 `783499ffdb2d501bf590b2e035acd027a882df10` / AGPL-3.0。当前 `THIRD_PARTY_NOTICES.md` 还列出 Brain Apache-2.0、DSH MIT 兼容补丁、独立安装依赖。新增实现应记录来源；不得把依赖、参考或适配代码统称为完全原创。任何复用必须保留相应许可与义务。

## 14. Checkpoints / artifacts

**现有调用链与存储**：`packages/session-adapter/checkpoint.js` 的 `captureSessionCheckpoint` / `verifySessionCheckpoint` 等待 idle、刷新并读回原生 Session，核对整个事件前缀及 hash，拒绝未闭合 turn/tool 和未知结果。`packages/gateway/src/harness/session-checkpoints.ts` 将证明写入不可更新/删除的 `ga_session_checkpoints`；`runs/commands.ts::resume` 检查原 checkpoint、run version、未知结果和任务等待条件后创建受约束 continuation。这里验证最新 Session 含原前缀，**不回滚原生日志或权限**。

文件方面，`artifacts/service.ts` 已实现上传、版本/CAS、正式输出来源，`resolver.ts` 按 owner/conversation、版本、大小和租约解析附件，`archive-service.ts` 提供归档/恢复。`server.ts` 已有 upload/complete、artifact preview/diff/download/restore。`RoleConversation.tsx` 能预览上传的 text/image 并下载正式输出。新出现的 `always-on/snapshot-provider.ts`、`work-cycle-workspace.ts`、`workspace-journal.ts`、`workspace-diff.ts` 已能隔离复制、恢复和生成非授权 diff；其 `execution_authorized:false` 不是通用恢复按钮或源目录应用权限。

**真实剩余链**：面向用户的文件 checkpoint 清单 → 明确选定的 workspace/path/版本 manifest → 快照预览/diff → 原权限下的冲突检查与显式 restore → 失败/中断恢复；另需 Session fork 的正式身份、预算、输入与附件绑定。不能只给现有 native checkpoint 增加「撤销全部」标签。文件恢复不撤销邮件、Git push、网络写入或已计费调用。

**可独立闭合**：先给现有 artifact version/diff/backup-status/restore 加 owner 界面与状态回执，无需实现 Session rewind；随后把受限 snapshot provider 接到独立 file-checkpoint service，复用 manifest/hash 和路径边界，但不直接复用 Always-on 的 cycle authority。新 contract 在 `packages/gateway/contracts/{operations.json,openapi.yaml,openapi.json}` 与生成类型同步，BFF allowlist 对应复核。

**验证入口/依赖**：`test/workbench/session-checkpoints.test.mjs`、`test/artifacts/{artifacts,resolver,archive-service,upload-recovery}.test.mjs`、`test/workbench/task-file-artifact.test.mjs`；新增 restore stale-version、删改源、跨 owner、symlink、进程中断、未知外部动作不被重放用例。依赖 workspace 身份/文件版本链；实机文件系统一致性与保留策略为后续操作者验收。

## 15. Git workbench

2026-10-20 增量：[原生 Git 本地通道](2026-10-20-native-git-local-transport.md)
已接入现有 adapter，可在共享原数据库和物理仓库的两个进程间调用原执行器。
实际 SDK 验收完成暂存，并在准备下一次撤销暂存时验证原审批撤销确实阻止写入。
这不等于前端写入口已开放；共享／隔离产物发布、检查点、原 HTTP/BFF/UI 和部署
验收仍按下方剩余链推进，不能以通道 ready 代替整条功能验收。

**现状（2026-10-19 更新）**：已有 owner/project 归属的 Git 状态、分支与 staged/working diff API 和移动端 Git 页，以及精确快照的审批界面。内部 stage/unstage 执行具有原始请求、准备/派发/结果/处置记录与真实崩溃恢复测试；本轮新增原始受理事务及受理/当前结果分别查询的 API、BFF 和客户端。实际 UI 写入仍未开放。DSH 原生 shell/Git 能力和公开提交扫描均不能代替产品写入授权。详见[原始受理与历史查询](2026-10-19-git-original-admission-history.md)。

**真实剩余链**：原始工作区协调（Agent turn、共享写入、检查点恢复）→ 原受理 HTTP 事务与 producer 生命周期 → 实际 stage/unstage UI、取消/重启/未知结果恢复 → commit/revert/discard/untracked delete → 分别授权的 remote fetch/pull/push/publish 及远端冲突/未知结果恢复。已完成的有界只读展示和内部物理执行不重复计为新完成项。每一步继续防止 pathspec 注入、shell 拼接、仓库 root 替换、跨 owner、符号链接和大输出泄漏；remote 展示必须脱敏。

**接续顺序**：按[HTTP 与工作台执行计划](../superpowers/plans/2026-10-19-git-index-http-workflow.md)接入原工作区协调与原始 producer，随后开放移动端本地操作。索引独占租约不能代替整个工作区的互斥；历史受理不意味着后台正在执行。commit、破坏性与远程操作各用单独意图，不把「查看 diff」变成写入授权。

**验证入口/依赖**：现有 `packages/gateway/test/git/`、`test/contracts/contracts.test.mjs` 与 `web/workbench/` 测试已覆盖只读/审批/内部执行及历史查询。接下来补原工作区并发互斥和实际 React/BFF/Gateway 变更链的端到端验收。依赖原 project ownership、工作区/Session/run/角色身份和现有审批；远端账户及推送发布仍须单独的真实授权验收。

## 16. Commands / skills

**现状**：`runs/commands.ts::RunCommandService` 和 `harness/command-dispatcher.ts` 是 run steer/cancel/resume 的持久命令，不是用户斜杠命令或 skill 管理器。`packages/dsh-host/standard-preset.mjs` 与 `create-profile.mjs` 复用原生 preset/工具并审计注册表；当前产品未提供 skills discovery/load/install/config/document addressing 路由和 UI。仓库 AGENTS/Brain 指令也不是 skill 执行服务。

**真实剩余链**：从已安装且审计过的原生 registry 读取 manifest → 展示命令与文档来源、版本和 scope → load 只返回所选资源 → 安装到 operator/owner 指定隔离根并校验路径/来源/许可证 → 配置版本与 reload → 用户选择命令后的原 DSH 执行及回执。Markdown 内容和命令说明均是不可信输入；load 不得授予运行/写入权限。

**可独立闭合**：只读 adapter catalog 协议和 Gateway owner-scoped projection，加命令/skill 详情及文档寻址 UI；用内容 hash/version 固定读取，不执行安装脚本。第二阶段实现显式安装 intent，固定目标范围、原子 staging/rename 与失败清理，保留原版本供 rollback。

**验证入口/依赖**：adapter 扩展遵循 `packages/session-adapter/index.js::createAdapterHandler` 的 bearer/loopback 边界与 `test/native-endpoints.test.mjs`；host 注册验证参考 `packages/dsh-host/test/official-profile.test.mjs`。新增 traversal、越界文档引用、恶意 manifest、重复安装、撤销 scope、reload 失败不激活用例。依赖原生 registry 接口审计，不能从 fixture 猜测生产接口；外部安装来源与许可证可在实现前固定，真实安装验收随后执行。

## 17. MCP / plugins / hooks

**现状**：`packages/session-adapter/index.js::apply` 自身是 Cordis 插件并注入 Session/工具服务；`memory-plugin-runtime.js` / `memory-runtime-loader.js` 为指定、固定来源的可选记忆插件提供绑定；`packages/web-decision/web_decision/budgeted_mcp.py` 是已有 Web 工具预算桥。这些均不是通用 MCP server、plugin、hook 的管理生命周期。未发现 Jot 通用安装/升级/删除/权限配置界面。

**真实剩余链**：只读 inventory 与连接状态 → 展示工具 schema/来源/权限 → operator 明确配置与凭证引用 → 连接/握手/有界 health → tool 执行沿原 DSH permission/预算/取消/回执 → 断连与 unknown 结果 → 版本切换/撤销/移除；hook 在指定事件与批准环境执行，不能让网页/工具输出自动注册执行代码。stdio MCP 进程、HTTP MCP 凭证和宿主插件代码加载是不同风险和生命周期。

**可独立闭合**：先提供已加载 registry、MCP connection 和 hook 配置的脱敏只读 projection；接着实现连接配置 schema、expected_version、禁用/撤销与健康状态。安装/升级以 staging + integrity/license manifest + 原配置 snapshot 实现，不能通过关闭权限或 module HMR 快捷热装到生产 Host。

**验证入口/依赖**：复用 adapter bearer/cancellation、`packages/session-adapter/test/memory-plugin-runtime.test.mjs` 的固定插件约束和 `packages/web-decision/verification/verify_budget_mcp_sdk.py` 的预算桥边界；新增恶意 tool result、跨 owner config、旧 epoch tool、请求已发后断连、重复 install、失败 reload 保留旧版本、hook 未授权事件测试。真实 MCP endpoint/包安装/操作系统进程权限是后续验收；只读 registry 与配置生命周期不需要外部账户。

## 18. Voice

**现有链**：`packages/session-adapter/voice.js::createVoiceAdapterHandler` 通过 bearer 保护 catalog/transcribe，只投影安全 provider 元数据；Gateway 的 `voice/adapter-client.ts`、`voice/wav.ts`、`voice/service.ts::VoiceTranscriptionService` 和 `server.ts` 的 POST/GET/DELETE transcriptions 处理 WAV 限制、owner/conversation、内容 hash 幂等、并发上限、取消及过期。音频只存执行内存，成功文本只在内存保留十分钟，重启显式标记失败，不谎报已保留 transcript。`config.ts` 的 voice switch 默认关闭。当前 `RoleConversation.tsx` 无录音/转写草稿入口。

**真实剩余链**：麦克风能力/权限 → 有界录音与规范 WAV → 明确开始转写 → 原 job/request key 轮询/取消 → 所属 conversation 的可编辑草稿 → 用户发送原聊天管线；切会话、卸载、权限撤销、结果过期与重启都需可理解状态。ASR 供应商安装/下载/唤醒目前只有 catalog 状态观察，未形成 Jot 的 setup 控制。TTS 是另一个未实现契约，不能以 ASR 成功推断。

**可独立闭合（优先）**：新增 `web/jot/voice-controller.mjs` 与 recorder/VoiceInput 控件，调用现成 capability/jobs；将结果填入原 conversation 草稿而不自动 send，保留用户同时输入内容并拒绝过期/外来 job 覆盖。只在就绪 capability 下显示可录音入口；不把 unavailable 伪装成 provider 缺失已确认。

**验证入口/依赖**：现有 `packages/session-adapter/voice.test.mjs`、`packages/gateway/test/voice/transcriptions.test.mjs`；新增 fake recorder/fetch 的取消竞态、切换会话、同 key 同 bytes/异 bytes、draft 合并、失败重试、过期/重启测试。UI 可先用假录音/假 adapter 完成；真实浏览器麦克风、FunASR/其他 backend 与语音质量需操作者实测。TTS 另行设计、验证、计费与取消，不纳入本闭合。

## 21. Web / editors

**现有链**：`web/main.tsx` 是独立本地 UI；`web/workbench-entry.tsx` 经 `src/workbench-proxy.mjs` 连接 Gateway；`web/jot/{conversation-controller,projection,upload-controller,goal-controller,durable-goal-receipts}.mjs` 与 `RoleConversation.tsx` 已有 snapshot/SSE、排队消息、显式重试、附件、Goal 和交互审批。`RoleConversation` 支持 text/image 上传预览，其他类型明确 unsupported。`SharedWorkspace.tsx` 有共享文件编辑链。现有主题与响应式 CSS 并不证明键盘/读屏/小屏全部验收。`workbench-entry.tsx` 当前静态引入 Workbench/RoleConversation，未见完整按大型编辑器拆包的机制。

**真实剩余链**：统一文件入口 → 大文件分段/有界预览 → Office/PDF/code 的安全只读 preview → 可选编辑器 → 保存 expected_version/hash → 冲突/reload/恢复；模型选择须服从后端 capability、活动 run 与预算，不能只改前端 label。还需完整 keyboard focus/dialog、读屏错误/状态、移动端输入与 bundle 性能验收。

**可独立闭合（优先）**：先扩展 artifact 历史/预览面板及 keyboard/focus；再通过 `React.lazy`/dynamic import 拆 Workbench 和未来 editor，提供明确 loading/error。Code editor 可基于现有文本 CAS 单独闭合。Office 预览复用 `artifacts/document-renderer.ts` / file-engine 的安全产物管线，返回 owner/version 绑定预览件，不让不可信 HTML 在同源执行。编辑器不能直接访问宿主文件路径。

**验证入口/依赖**：`npm run test:workbench-ui`、`npm run test:goal-ui`、`web/jot/*.test.mjs`、`test/workbench-files-proxy.test.mjs`、Gateway `test/artifacts/document-renderer.test.mjs` 与 file-engine 测试。新增 stale saves、服务切换、预览 URL 生命周期、HTML/SVG 不执行、错误 focus、键盘操作和移动 viewport 用例。浏览器/Office 真实渲染验收独立于 UI 状态单测；包体积使用实际 build 产物测量后才能声称优化。

## 23. Onboarding / settings

**现状**：`packages/gateway/src/config.ts::loadBffConfig` 读取必需 CSRF、origin、workspace/internal token 及可选 voice/Goal/budget 配置；`packages/dsh-host/create-profile.mjs` 创建固定官方 profile，`standard-preset.mjs` 与原 registry 审计判定 host readiness；`web/workbench/readiness-ui.mjs` 和任务界面显示可执行条件。`server.ts /v1/capabilities` 返回实际配置/voice readiness，但 `models:[]` 不等于已有模型目录与 provider 检测向导。可保存角色/任务不说明宿主可执行。

**真实剩余链**：识别本地/Gateway 模式 → workspace 选择与验证 → 脱敏 provider 引用 → 明确同意的小额 test 请求及实际 image modality probe → 注册/健康状态 → 保存版本化设置 → 安全 reload/retry/迁移。健康测试本身可计费，不能以普通 GET readiness 偷偷触发 provider 请求。私钥只能写私有凭证存储，公开设置仅保存引用。

**可独立闭合**：先实现只读 setup status 与故障原因/重试按钮，投影原生 host registry、required config presence、worker health 与 capability，禁止泄漏路径/endpoint/token。其次独立实现版本化 settings schema 和迁移、provider test intent/预算/receipt；设置保存前检查 active-run 影响，不静默重启活跃 Agent。

**验证入口/依赖**：`web/workbench/readiness-ui.test.mjs`、`packages/dsh-host/test/{create-profile,official-profile,startup-bind-retry}.test.mjs`、`packages/gateway/test/workbench/{routes,server-integration}.test.mjs`。新增配置缺失/损坏、旧 schema、重复 test、超时未知费用、无法 rollback、跨 owner secret reference 测试。真实 provider 凭证、image-capability/费用与部署配置验收归操作者；不应因此推迟 status/schema/UI。

## 24. Desktop packaging

**现状**：没有查到 Electron/Tauri app manifest、main/preload、签名/构建目标或 desktop updater。现有本地 Web、Playwright、DSH native picker 与 Computer Use 均不能算 Jot 桌面发行包。Gateway/Host 的多个进程有独立监督和身份要求。

**真实剩余链**：明确桌面运行模式 → 固定 loopback 后端发现/启动 → 窗口与权限 → 隔离 renderer/preload IPC → 导航/download/open-external allowlist → 私有数据/日志路径 → 单实例与正常关机 → OS 包/签名 → 更新/回滚。renderer 不拥有 Node/shell；外部页面不能进入特权 IPC。退出要等原 Session/队列 flush，不能杀进程后声称数据已保存。

**可独立闭合**：首先建立使用本地 `src/` runtime 的最小壳与可验证生命周期合同，或者明确只连接配置好的 Gateway；两种模式分别显示状态。先完成未签名本地包、IPC 拒绝测试、端口占用、启动失败与退出测试，然后补平台集成。不要顺带在 shell 中新建第二执行后端。

**验证入口/依赖**：需要新增 desktop package 的独立测试/构建配置；复用本地 `test/{api,runtime,lifecycle}.test.mjs` 与 snapshot/receipt 恢复证据，新增恶意导航/IPC、origin、重复实例、后台 crash、未知写入与退出超时用例。OS 签名、公证、图标/协议关联、安装权限与真实 Windows/Linux 包验收归操作者。此行当前只达到需求/源码缺口盘点，不是已有壳。

## 25. Install / update

**现有链**：根目录 `package-lock.json` + README 的 `npm ci/build/start` 可安装本地运行时；Gateway 有独立 lock/build（Python 模板生成 + TypeScript）与监督进程说明；`packages/dsh-host/create-profile.mjs` 复制锁定 `runtime-package-lock.json` 并引用本 checkout adapter，拒绝覆盖现存 profile。`DEPLOYMENT.md` 与 `HOST-BACKUP.md` 写明私有数据备份和分阶段启动。没有查到 Jot 一键 Windows/Linux 安装器、Docker compose、版本更新 API/管理页或事务升级器。当前 package version `0.1.0` 也不是完整发行协议。

**真实剩余链**：识别 OS/prerequisites → 固定版本/完整性/许可证 → 安装到版本化只读目录 → 私有 data/config 独立根 → 数据与文件一致备份 → 迁移计划/兼容性 preflight → 停止并排空旧 consumer → 同步 API/UI/Worker/Host 版本 → 只读健康检查 → 显式激活 → 失败回退/保留未知结果。旧 queue consumer、native compatibility patch 与 irreversible DB guard 不能用简单覆盖二进制回滚。

**可独立闭合（优先）**：先实现纯本地 release manifest + preflight/report，明确 Node 根要求 >=24、Gateway manifest >=22 与原生 SQLite/宿主实际要求的差异，不自动声称 >=22 即整套可运行。随后实现不激活的 staging installer 和一致备份/恢复演练；固定 config/preset/contract protocol/hash 与 consumer compatibility，禁止重新生成凭证、重置 occurrence/count/lease、重放 unknown 或在 Agent 可写目录加载 Host 代码。Docker 单独建明确 volume、用户权限、shutdown/health，不等同 Windows 原生验收。

**本轮实际补齐**：新增 `scripts/release-preflight.mjs`，支持 standalone/Gateway/Host、source/runtime、固定 JSON 检查码和退出 0/1/2；按 profile 读取 engine，检查指定入口、lock/direct dependencies、运行目录与配置形状，Host 检查 prepared pinned lock/launcher。只读、不解析 `.env`/token 正文、不访问服务。见 [离线 preflight 使用与覆盖边界](2026-10-17-release-preflight.md)。这是可运行的离线结构检查，尚无安装器、完整 release integrity manifest、生产健康证明、升级激活或回滚器。

**验证入口/依赖**：`packages/dsh-host/test/create-profile.test.mjs`、`scripts/verify-{public,git-public}.test.mjs`、数据库迁移/rollback custody 现有回归与 `HOST-BACKUP.md` 对应工具。新增离线 install fixture、部分 staging 失败、磁盘满/路径空格、existing profile、篡改 digest、旧 consumer 拒绝、迁移失败保留原数据、restore 不自动启动测试。实际下载/安装脚本、签名、registry 发布、真实数据库备份、升级切换与回滚由操作者实机验收；manifest/preflight/staging 可先自主完成。

## 可并行推进的最小闭合包

后续原验收卡已补完整隔离版本证据展示，详见
[完整工作结果审阅](2026-10-20-complete-work-review.md)。清单、选定方案、原始／结果
版本与差异来自原冻结 candidate；不同于新增共享写入、项目 apply、Git 暂存或检查点
恢复权限。这些发布与恢复环节继续按原全链计划推进。

| 优先级 | 独立闭合包 | 完成判据 | 前置与边界 |
|---|---|---|---|
| P1 | Voice 草稿 UI | fake recorder + 现有 job API 覆盖 record/poll/cancel/draft/切会话，绝不自动发送 | 已有 ASR API；真实麦克风另验 |
| P1 | Artifact 历史、diff、归档状态/恢复 UI | 原 owner/version 回执可读，原上传保留，失败可恢复 | 已有 artifact API；不是 Session rewind |
| P1 | 只读 Git inspection + UI | 临时 repo 多状态、root/owner/参数边界、输出限额通过 | project/workspace identity；无远程写入 |
| P1 | Setup/readiness projection | 故障可见、无 secret、读取不推理/计费 | 使用已有 Host audit；不伪造 ready |
| P1 | Release manifest/preflight | 离线确定版本/依赖/protocol/可回退条件，不安装、不激活 | 现有 lockfiles/profile/备份契约 |
| P2 | Skills/MCP/插件只读 registry | adapter 的真实 registry、scope/hash/version 与 Gateway projection/UI 相连 | 原生接口 source audit；读取无执行授权 |
| P2 | Web lazy boundaries/accessibility/code CAS editor | bundle 实测、键盘可用、版本冲突不覆盖 | 已有文本文件服务；Office 另验 |
| P2 | 文件 checkpoint service | manifest/diff/显式 restore/recovery 全链，保留未知外部副作用 | 复用 snapshot primitive，独立权限审计 |
| P3 | installer staging / desktop shell | 本地可重复构建与失败恢复，活跃执行不丢失 | release manifest、生命周期合同；签名发布后验 |

这些包可按文件所有权隔离并行，但 schema/contracts、`server.ts`、BFF allowlist、全局导航和 release manifest 应各有单一整合者。独立实现者先定义 contract/fixture，再由整合者串联并按仓库要求执行 root test/build 与 Gateway build/tests；本盘点没有运行这些检查，不能作为合并或生产启用依据。


## 后续实施记录：隔离文本输出的原 artifact/review 接线与发布边界

本轮allowlist只覆盖隔离`jot_workspace`文件及原任务操作接线，不是所有外部工具的总沙箱。
原allowed external tools仍受原role、lease、依赖、Goal和预算约束；不扩展浏览器或外部动作
权限，native work成员仍fail-closed。

原 completion/review/`ArtifactService` 已连接内部 isolated lead 文本版本：保存明确
workspace/isolated discriminator、cycle/snapshot/local receipt、原 proof、producing run
和 delivery run。历史 isolated reader 独立校验原 operation request digest、response/proof
及 SQLite BLOB hash/size；旧共享 pin 仅经实际原 shared receipt 解码。审核与交付使用冻结
不可变版本，绝不按同名 path/version 选择可变树或共享 fallback；交付只是复制，不是项目 apply。
原上传、generated group 和 shared/native-shared artifact 契约保留。

完整 base/result manifests、diff、selected objective 和 plan/source/call-set 哈希已经
内部冻结，并对 proposal/candidate/current 精确 pin；现有产品 review 仍只展示所选文件/criteria。
owner 可读的全量 diff/base/plan UI、通用 binary/native producer、文件 checkpoint/fork/restore
产品链和独立 reviewed apply/rollback/unknown reconciliation 均未由本轮关闭。

本轮 inspection/business-completion13/13、普通 output/acceptance27/27 和历史 reader
硬化3/3 是不同针对性证据，不能相加当作全套；27 项组排除此前真实 loopback 权限失败个案，
该个案未改成通过。typecheck、root50/50、UI212/212 通过。完整Gateway/build/披露当前结果及首轮失败统一记录于下文；历史full-suite/build不能替代
精确发布readback与SDK稳定性门槛。

较早一次修正后的实际 installed SDK两例2/2通过（37.7s）：direct10条Messages请求/60 reported
tokens；cold wait/reply11条/66 tokens，重启Host+Worker并保留原work Session/Goal、
occurrence与完整selected objective。两例验证exact1 isolated write、原native completion、
owner验收、immutable artifact交付和无held/unknown/reserved的ledger。更早pending-step/
末尾fixture查询失败保留失败状态。官方typed missing-Session兼容与GoalBridge lease保留/
readonly observation分离已修正。完整adapter回归548总/524通过/24既有SDK依赖skip/
0失败（2.75s，未设置可选SDK模块环境），与显式installed SDK两例独立记录；package
dry-run54文件包含新helper，真实解包import测试通过。
受控脚本本地Messages传输不证明真实provider质量。内部可信配置默认不启用，未生产部署。
授权 isolated native 成员（目前拒绝）、同库两个 isolated cycle/version 接受矩阵、
report-memory/autodispatch/retention/Git，以及各产品/发行能力行原有剩余项继续开放。
参见[当前工作树完整边界](../superpowers/plans/2026-10-17-always-on-discovery.md#current-internal-lead-io-and-frozen-output-integration)；
本节不宣称全部26完成，不新增总体百分比。


### 当前最终本地 gate、首轮失败与 Host 待修发现

首完整Gateway运行1729总/1719通过/3失败/7既有或opt-in skip（668.09s），3失败全部为
memory-pump。窄Workbench schema只有悬空current-occurrences view、缺原task-occurrences
base table时，新Session识别查询view导致普通memory processing失败；现先检查真实base
再query view，不合成原task权限或放宽work恢复。修后目标回归32/32通过：普通Session20、
工作Session2、operation-gate5、memory-pump5。首轮全量失败保留失败记录。

修后完整Gateway重跑1729总/1722通过/7既有skip/0失败/0取消（632.263s）。Windows
Gateway build与前端Vite build通过；public6测试通过，891份working-tree文件preflight
零findings，Brain lint-links通过。两个test fixture仅缩短合成bearer字符串以通过隐私扫描，
相关18目标测试全通过；没有修改扫描规则或runtime credential处理。root50、UI212、
adapter和显式SDK证据分别记录，不相加成总体capability完成。

新final review实证P2 Host生命周期缺口：composer非必选且native Session历史缺失时，
Host可能先create，尚未确认原首次work run及不存在saved native Goal mapping。Host
before-create修正的35/35目标测试通过，独立fresh review确认覆盖且无新具体finding。
最终完整adapter为556总/532通过/24既有skip/0失败；最新no-recreate实际SDK2/2通过
（33.13s），direct10条Messages、cold11条，保留原Session/Goal、完整selected objective、
exact1 isolated write和原交付。Gateway/build先于此Host-only变动，因此另列它自己的目标/
完整adapter/SDK证据；这些通过不宣称修复SQLite锁争用。默认off、未生产部署；SQLite稳定性解决、精确发布readback及真实provider/
部署接受仍是门槛。

### 此前 final-log SDK 反证：冷 continuation 的 SQLite 稳定性仍开放

此前final-log实际SDK重跑仅1/2通过：direct通过，cold在原step-admission路径遇SQLite
`database is locked`。原busy_timeout为75ms；具体持锁者和根因没有证据，不能猜测，
没有提高timeout或盲重试来宣称修复。较早2/2保留为该次真实证据，不能替代最终全通过或
稳定性结论。cold continuation的SQLite contention/stability、修正后的完整验收重跑仍待解决。
本次为受控本地脚本Messages传输，不是实际provider调用或生产验收；没有虚构final成功。

另一次只读cold trace为1/1通过：7552 records、4个SQLite进程、零SQL error，未观测到跨
microtask/event loop未关闭transaction。观测到isolated原receipt事务56ms、Worker BEGIN
等待46.598ms、complete proposal44ms、相邻Goal binding/task state25–31ms；原75ms
busy timeout下同步跨进程争用仅是可能解释，不能回推此前具体持锁者/根因。trace通过不覆盖
此前final-log SDK1/2失败；最新no-recreate2/2亦不能证明锁问题已修复，SQLite contention/stability继续开放。
