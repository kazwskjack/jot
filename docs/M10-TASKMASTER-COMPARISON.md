# M10 Taskmaster、PRD 与原 DSH 能力对照

本对照绑定上游 `783499ffdb2d501bf590b2e035acd027a882df10` 和 Jot 基线 `286de16a0fda19268a03953af9ad3c9b717cd1fa`。上游原清单的 Git blob 与本次读取全部一致；工作树 CRLF 与清单 LF 的摘要分别保留。原模块明确范围是 `ui/server/routes/taskmaster.js` 加 `src/task/**`，共 5 个文件；旧路径分类将后四个归为 M02，但不从 M10 明确范围遗漏它们。M10.01/.02 已 D，本次不重开。

## 使用的业务链

`TaskPrdPanel` → 已注册 `/v1/persistent-tasks/:taskId/prd/sources|preview|bind` → `TaskPrdService` → 同一原暂停任务目标 → 用户显式恢复/立即运行 → 原 Worker/Session → 已安装 DSH → `jot_workspace tasks.upsert/tasks.next` → 原 `PersistentTaskService` 与准备度账本。

原文由同 owner/workspace/project 的版本化逻辑文件或原上传提供，包含 `.md`、`.markdown`、`.txt`。预览验证原始大小、UTF-8、控制字节、哈希和版本。最多 65,536 字节，合成完整目标最多 12,000 个 JavaScript 字符。目标超限明确拒绝，不能截断验收条款。PDF/DOCX 提取、Taskmaster tags/tasks.json 导入不属于当前输入支持。

绑定只更新原暂停任务目标并创建不可变修订，不新建任务/运行/预算；重试原 key 返回原回执。DSH 获得冻结原文及目标，依赖子任务由原工具创建，UI 不拆解。`tasks.upsert` 持久化的是原 run 的命令回执 `wb_tool_receipts`，不是可证明业务完成的执行证据。准备度、子任务状态或模型自述不能代替审核完成。

## 完整上游路由对照

| 上游入口 | 实际上游行为、默认/异常 | Jot 对应与边界 |
|---|---|---|
| GET installation-status | which/where task-master，再 --version；读取 HOME MCP 配置；installed && hasMCPServer 判 ready，未证明密钥有效 | 原 DSH/Worker 链无需 Taskmaster；未扫描 HOME、PATH 或用户密钥。`task_prd` 是功能声明，`execution_ready` 是宿主配置门禁，不把布尔配置宣称为本次 SDK 启动成功。外部 CLI/MCP 安装状态未检查，不报告已安装/未安装。 |
| GET detect/:projectName | 查 .taskmaster、tasks/tasks.json、config.json，汇总统计；MCP 配置分 fully/taskmaster/mcp/not-configured | 原 owner 任务、角色、项目作用域和 PRD sources/readiness；不将任意主机路径当 owner 权限，也不冒充 .taskmaster 检测。 |
| GET detect-all | 遍历所有项目；每项目状态或错误并汇总 | 复用原任务/角色列表和每任务准备度；不读取其他 owner 的全局配置。没有外部 Taskmaster 批量检测。 |
| POST initialize/:projectName | 占位接口，始终 501 | 不包装为可用安装功能。原任务创建独立且已存在。 |
| GET next/:projectName | CLI next，失败后 HTTP 回读 task list，选首 pending/in-progress | 原 `tasks.next` / readiness.next.items，重新核验授权、依赖和证据；不使用“首个 pending”代替实际可执行。 |
| GET tasks/:projectName | 读取 legacy array、tasks 包装或 tagged master/首标签；缺文件空列表，坏 JSON 500；缺状态默认 pending，priority medium | 原稳定 Task/Subtask ID、优先级、状态和计数；没有导入外部 tasks.json/tags，不宣称兼容该格式。 |
| GET prd/:projectName | .taskmaster/docs 顶层 .txt/.md 列表，缺目录空；按 mtime 排序 | 已有逻辑文件/原上传选择器，固定版本/哈希；候选截断有明确提示。不需要复制到 .taskmaster/docs。 |
| POST prd/:projectName | 校验文件名后创建目录并覆盖 UTF-8 内容 | 已有 Files/上传入口，使用版本/CAS、owner/project 校验；预览/绑定不隐式覆写文件。 |
| GET prd/:projectName/:fileName | 按主机路径读全文；缺文件 404 | `loadSource/readFileVersion` 或已验证原上传，精确版本/摘要；不接收任意主机路径。 |
| DELETE prd/:projectName/:fileName | unlink 文件，缺失 404 | 复用 Files/原附件生命周期入口；PRD 的不可变绑定不能删除或静默跟随源文件删除。无额外 PRD 删除 API。 |
| POST init/:projectName | 已有 .taskmaster 则拒绝；npx task-master init，自动回答 yes，广播成功 | 不自动下载、自动同意安装或写用户配置；原 DSH 已装能力复用，不建立第二调度/规划器。 |
| POST add-task/:projectName | npx task-master-ai add-task；prompt 自动 research，或 title/description 转 prompt；priority medium | 原任务/子任务编辑及 DSH tasks.upsert，保留 task/occurrence、版本、依赖和预算；没有外部 research CLI。 |
| PUT update-task/:projectName/:taskId | 仅 status 用 set-status，否则拼更新 prompt 交 CLI | 原子任务 CAS + acceptance/evidence 规则；状态更新不冒充业务审核。 |
| POST parse-prd/:projectName | 默认 prd.txt，append=false；numTasks 可选；npx parse-prd --research，成功广播 | 固定原文后由原 DSH 拆解；无需新建父任务/额度。没有外部 Taskmaster numTasks/append/research 协议，不声称通用解析器或真实模型质量已验收。 |
| GET prd-templates | 内置 web/API/mobile/data 四类模板，日期动态 | 现有独立中文目标/范围/验收/依赖模板；不复制 AGPL 模板，不宣称四套原模板等价。 |
| POST apply-template/:projectName | 默认 prd.txt，自定义替换后覆写；实际 helper 只有 web-app，其他列出的模板会 404 | 用户通过现有文件编辑/上传保存自己整理的模板，显式版本预览/绑定；不复制上游列出/应用不一致或无版本覆写。 |

Taskmaster 安装/全局 MCP 配置、tagged tasks.json、外部 research、上游模板全集属于明确未接入的兼容能力。上述逐项对照不把它们改名为已完成。M10.04 原标准要求核对安装/输入行为及实际需要包的审核；本链没有证明必须新增 Taskmaster 包，因而没有下载/安装/修改系统。若产品另要求外部 CLI 兼容，需先固定准确包名、版本、完整性、许可证及传递依赖，明确网络/密钥/配置/目录/取消/超时/升级回滚边界，再走已有安装和许可审核。不能从上游源码中的无版本 npx 推导授权或版本许可。

## 原清单逐文件核对

### src/task/index.ts

- Git blob：0d8162889cc1dbd63f9efa7ffb739b365ca87a1c
- LF SHA-256：0ac60df8a04385882bec1a17df0872e6a21e45d3e3dab276f4ee57200f6fa962
- CRLF 工作树 SHA-256：580cc85c11ddcedaa015d1dc72e3de8a526b8cd9926407a56a1b7db2acad6fc7
- 入口/导出：exports BackgroundTaskRuntime,TaskOutputStore,protocol types
- 状态存储：none; export surface only
- 异常：delegated to implementation
- 取消：exports StopTaskOptions/runtime stop
- 重启：no independent restart state
- 默认：no independent defaults
- 保留/适配/加强理由：Retain installed official SDK exports/preset rather than creating another background runtime registry.
- Jot 符号：packages/dsh-host/standard-preset.mjs readOfficialStandard/apply；packages/session-adapter/index.js
- 现有测试映射：packages/dsh-host/test/standard-preset.test.mjs；packages/session-adapter/verification/native-task-stop-runtime.mjs

### src/task/protocol/types.ts

- Git blob：280c7d16b7c15f4c5c52cd99c3ee5a4cd0bf6793
- LF SHA-256：82b667bd540e3ac1a40b554263fa968c44e431871e4108b2b95bcd462e69fecf
- CRLF 工作树 SHA-256：0c13d047d16cd10df46c92cdbd09ed7e56aa43ca624baa935069f551b5f99d33
- 入口/导出：background state/output/filter DTOs
- 状态存储：pending/running/completed/failed/cancelled, byte cursor, task/agent/session identifiers
- 异常：no runtime validator; TypeScript envelopes
- 取消：interrupted flag/statuscancelled
- 重启：Date timestamps/in-memory task envelope are not a durable restart protocol
- 默认：bash/monitor kinds; output nextOffset/totalBytes/truncated
- 保留/适配/加强理由：Keep actual SDK tool/runtime envelopes separate from product Task/occurrence; subprocess exit completed does not imply reviewed business completion.
- Jot 符号：packages/gateway/contracts/types.ts Run/TaskOccurrence/TaskSubtask；packages/gateway/src/runs/commands.ts；packages/gateway/src/persistent-tasks/service.ts；packages/dsh-host/standard-preset.mjs
- 现有测试映射：packages/gateway/test/routes/run-commands.test.mjs；packages/gateway/test/workbench/task-finalization.test.mjs

### src/task/runtime/BackgroundTaskRuntime.ts

- Git blob：40a81016392e03827bc8daafb11ea718aba2ea13
- LF SHA-256：deda338cfc4635b56b79656581eecea73f7f82b8e2e07de50ef2765775be2c5d
- CRLF 工作树 SHA-256：52e6e44cfe4824a36e8f17440bab049d6bef0c2837eb4b3fb4d7ef6110377605
- 入口/导出：start/list/get/wait/waitFor/stop/killForAgent/killAll/getOutput
- 状态存储：in-memory Map, child handles, output buffer and completion promises
- 异常：spawn errors become failed; bookkeeping rejects waiters; notification callback swallowed; unknown-ID errors; bounded simultaneous-active registry
- 取消：SIGTERM→SIGKILL; Windows taskkill /t/f; agent/session cleanup; wait abort does not itself stop child
- 重启：no persistent registry restore; disk spill is not task ownership recovery
- 默认：maxTasks32, graceMs5000, completionPreviewBytes4000, unbounded wait unless timeoutMs>0; Windows hidden attached children
- 保留/适配/加强理由：Reuse installed native SDK semantics and original durable Gateway command/lease/budget fences. Do not port AGPL shell spawning or equate tool/process completion with final product acceptance.
- Jot 符号：packages/dsh-host/standard-preset.mjs inherited official dsh-tool-bash；packages/session-adapter/index.js createAdapterHandler 的 /goal-stop → workbenchBridge.suspend；packages/gateway/src/harness/command-dispatcher.ts SessionCommandDispatcher；packages/gateway/src/persistent-tasks/service.ts pause/cancelActive；packages/gateway/src/workbench/model-budget.ts
- 现有测试映射：packages/session-adapter/verification/native-task-stop-runtime.mjs；packages/gateway/test/harness/command-dispatcher.test.mjs；packages/gateway/test/persistent-tasks/service.test.mjs

### src/task/storage/TaskOutputStore.ts

- Git blob：7b1ed7448b7646b48b8e577360b792dec0bf9487
- LF SHA-256：84fb9d78d06af6996303085884eb417850f9dddaeab27d5937e226f503e0a52b
- CRLF 工作树 SHA-256：e16401ffbf777a553a5f1031272b1de71d516d7ba4a8a40efb62ce5ba7fb480a
- 入口/导出：append/readSlice/totalBytes/close and optional spill queue
- 状态存储：1MB memory ring, totalSeenBytes/droppedBytes; optional taskId.log full append stream
- 异常：spill best-effort failures reset mkdir flag; memory remains bounded; close drops memory but retains counters/disk
- 取消：no process/cancel ownership; close does not stop a task
- 重启：new instance does not reload ring or counters; optional disk file does not restore ownership
- 默认：maxMemoryBytes1000000, maxBytesInfinity, no spill by default
- 保留/适配/加强理由：Retain SDK output/projection, original durable event cursors and reviewed product artifacts. No extra output store, no raw command output promoted to accepted PRD result.
- Jot 符号：packages/dsh-host/standard-preset.mjs actual SDK bash/output runtime；packages/session-adapter/index.js actual Session event projection；packages/gateway/src/events/event-store.ts；packages/gateway/src/persistent-tasks/review-outputs.ts
- 现有测试映射：packages/gateway/test/events/event-store.test.mjs；packages/gateway/test/workbench/task-review-outputs.test.mjs；packages/dsh-host/test/task-prd-native.test.mjs

### ui/server/routes/taskmaster.js

- Git blob：fe37697122f5dd99cd2544ddec2b0567427268b8
- LF SHA-256：39b43623481fbced2174a8cecc394a0bcae0e1203868e2c0a0afcea45d0f90cc
- CRLF 工作树 SHA-256：8ec9dcdfc2034892d79f382f218405aea2cbca9535a63c54754affa67b13e0a7
- 入口/导出：16 Express routes; checkTaskMasterInstallation/detectTaskMasterFolder/getAvailableTemplates
- 状态存储：external .taskmaster/tasks/tasks.json, .taskmaster/docs; global CLI/MCP metadata
- 异常：404 missing project/file;500 parse/spawn/read/write; initialize placeholder501; next falls back after CLI failure
- 取消：CLI children have no request-abort/timeout cancellation contract in this file
- 重启：files persist; unrecorded CLI operations have no durable command receipt or restart reconciliation
- 默认：master tag, pending status, medium priority, prd.txt, append=false; built-in template list4 but apply helper onlyweb-app
- 保留/适配/加强理由：Adapt user outcomes through existing native DSH task identity; do not copy routes/templates or execute npx. External CLI/config/tagged-tasks import is explicitly unsupported.
- Jot 符号：TaskPrdService.sources/preview/bind；TaskPrdPanel；PrdFlow；PersistentTaskService.subtasks/upsertSubtask；PersistentTaskAssessmentService.nextActions；registerWorkbenchExecution tasks.upsert/tasks.next；WorkbenchService.writeFile/readFileVersion；ArtifactService.initUpload/writeContent/complete
- 现有测试映射：packages/gateway/test/workbench/task-prd.test.mjs；packages/gateway/test/contracts/task-prd-product-entry.test.mjs；web/workbench/task-prd.test.mjs；packages/dsh-host/test/task-prd-native.test.mjs

## 调用方、取消、重启与默认值

补充读取了 taskmaster 的 `mcp-detector.js`、`taskmaster-websocket.js`、`processSpawn.js` 以及 `projects.js::extractProjectDirectory` 相关入口。上游的 HOME 配置扫描/绝对路径与兼容路径回退不迁移到 Jot；Jot 从已认证 owner、原角色和项目身份推导范围。WebSocket 全客户端广播不迁移为无 owner 的任务数据；复用原查询/受控 SSE。

上游 BackgroundTaskRuntime 的 registry 是内存状态，输出 spill 不能恢复 task ownership；wait abort 只停止等待，任务终止需 stop/kill；Windows 使用隐藏 attached child 和 taskkill 进程树，POSIX 进程组 SIGTERM→SIGKILL。completion 回调及磁盘 spill 是 best-effort，不能认证业务完成。相关上游测试已逐一读取（后台执行、并发32、串行33、Windows、超时/abort、spawn failure、异步 bookkeeping），没有在本项目重跑 AGPL runtime。

Jot 通过 `readOfficialStandard` 继承实际官方 SDK standard preset 中 bash/后台工具，不移植 AGPL registry/output ring。原 Gateway 的持久 RunCommand、Worker lease、任务 generation、原预算与原 Session/Goal stop/close 回执仍负责产品身份、取消和恢复；`native-task-stop-runtime.mjs` 是已有实际原生取消行为验证来源，本次没有将其模块探针替代为 M10.03 实际 CLI 验收。原任务暂停/归档不会退款或新建 task-total；未知外部结果保持 unknown，不以新任务掩盖。

PRD 专属 `wb_task_prd_bindings` 为 append-only，事务内提交任务更新和回执，失败一起回滚。缺源/源损坏/版本变化/角色变化/原执行未闭合/未核对预算均拒绝。预览只读，未知绑定命令保留原 key/内容，同页签只存标识与摘要，不保存正文或自动重发。新预览重置确认，未确认不运行。已绑定源后续编辑不改变冻结目标，绑定新修订不会递归叠加旧 PRD。

## 许可与证据状态

上游仓库 LICENSE 为 GNU Affero GPL v3，五个文件仅作为行为参考；没有复制其实现、测试、模板或运行时代码到产品。Jot 继续复用既有 Apache-2.0 项目实现与已安装 `@deepseek-ai/dsh@0.2.1-rc.2` 的 MIT 包声明，官方 SDK 原声明/来源继续保留。本结论不推测未安装 Taskmaster 包的版本或许可证。

M10.03 旧成功回执固定到原6不可变提交 c72c02be422bd04d5887c73c7f4cc8724eddc126；测试 Git LF SHA-256=c31bf10c7816d4d4330e487b1d9a9c9260803274a18f639372d341d89c4291b1，报告工作树 CRLF SHA-256=c06799d41269a3f82a8e7e6ad1c57d58a0e2d61999dea3ceb30a2228aea85461；成功原生日志 SHA-256=8a496df1d37b3e223d734d425afdd5ffddf4a63a8a8f5ad9c6e5faf5f9dbe2f1。真实 Gateway/Worker/SDK 产生两条依赖子任务及原累计预算，模型仅为本地 scripted HTTP。PRD service/routes 与当前源字节相同；其他链路文件有后续变化，不能把旧通过改称当前完整树通过。

本次当前 SDK 三次启动均未进入 Jot adapter，模型调用0；分别保留原30秒、已有60秒启动界限及 Node ESM 模块诊断的失败和真实时长。未进一步增加超时，未替换 SDK，未用模块 fixture 冒充通过。原始 ESM trace 显示进入官方 profile-boot 与 sandbox-policy 的 zod 依赖加载，尚未加载 Jot preset/adapter；具体卡点仍需环境链定位，不能判定模型或 PRD 业务失败。新增当前源 fingerprint/持久命令回执断言尚未走到，明确保持待实际 SDK 启动后验证。

本次新增 `.markdown`、非法 UTF-8、控制字节、超过65,536字节等实际 Gateway 原上传边界用例通过；不重跑已D的全部 PRD 绑定/账本套件。完整五文件源/行为/许可对照已形成供指定14审阅，仍由14判正式ID关闭；当前SDK新证据动作保持 HOLD。未改 ledger 或共享源。
