# 剩余执行链核查（8 / 26 项）

日期：2026-10-17。范围为 `docs/PILOTDECK-PARITY.md` 的 conversations/execution、context/token、models/routing、tools/concurrency、browser、computer-use、credentials/auth/network、observability/testing。只读核查当前源码、测试源码及 Brain `native-goal-boundary`；本次没有运行测试、连接真实服务、启用生产开关。下文“有测试”仅表示已有测试文件/历史证据，不能解释为本次通过。其他 18 项由主清单负责。

`src/` 独立轻量运行时与 `packages/gateway/` 扩展服务不是同一条产品契约；一个实现不能替另一实现完成验收。DSH 保留规划与原生 Goal 权威；Gateway 保留所有权、批准、租约、账务和规范交付。下列建议均连接原执行链，不引入第二规划器。引用上游的锁定版本/AGPL 来源见 `docs/PILOTDECK-PARITY.md`，不得因本表而省略依赖许可。

## 1. Conversations / execution

- **当前完整路径与符号：** `packages/gateway/src/server.ts` 的 conversation/run/command routes → `conversations/repository.ts`、`runs/commands.ts` → `harness/coordinator.ts` / `HarnessWorker` (`harness/worker.ts`) → `OfficialSessionRunner` (`harness/official-session-runner.ts`) → `session-controller-client.ts` → `packages/session-adapter/index.js` → 原 DSH Controller/Session。`SessionCommandDispatcher` 保留原 Worker lease 与补充命令独立 RPC；`ordinary-input-admissions.js`、`ordinary-claimed-composer.js` 保留不可变 admission/entry。`projectSessionFrame` → `ga_events`/规范消息。`OrdinaryFinalRecoveryPump` → `OrdinaryFinalPublisher` 已存在，不能再把“历史最终答复恢复未实现”当作事实；相关 outbox 与 rollback custody 已进入源码。
- **已实现/本地证据边界：** 流、取消、补充、原始输入/claimed/pending 恢复、历史接受修复及最终发布均有实现和专门测试；Brain 记录实际 SDK + 脚本 provider 的进程死亡/幂等案例。`harness/main.ts` 的 original input、steering、steering reconciliation、final reconciliation 开关仍须显式启用；`ordinaryFinalRecoveryEnabled` 检查依赖，启动检查 trusted history readiness。
- **剩余实际闭环：** 所有 worker/notification consumer 的兼容版本、关闭旧 in-flight actor 后的启用/回退，未知模型/工具费用对账，显式 Goal 再激活和更广图像/文件格式真实 provider 语义，持久物保留/恢复，真实多进程部署与断网/主机死亡。会话 fork 必须单列验收：现有 Session/文件 checkpoint 不能直接证明完整消息、附件、角色与批准隔离的 fork。
- **下一代码契约：** 优先在 `packages/gateway/src/harness/main.ts`、`harness/ordinary-final-recovery.ts`、`channels/historical-final-queue.ts` / `historical-final-send.ts` 和 `packages/dsh-host/` 现有启动检查加入只读 rollout manifest：`{protocol, source_revision, native_version, supported_consumer_protocols, enabled_features, ready, reasons}`；必须明确 unknown，不创建 Agent、不 rearm、不清 entry/费用 hold。若实现 fork，先扩展 `conversations/repository.ts` / 原 checkpoint API，契约需绑定 source owner/conversation/session/seq/checkpoint，创建新身份，保留 artifact 来源且不复制批准/执行权。
- **依赖/测试/人工边界：** 依赖第 8 项 readiness 与可信入口。复用 `packages/gateway/test/harness/ordinary-final-readiness.test.mjs`、ordinary-final/steering 测试和 `packages/session-adapter/verification/` 原实际 SDK fixtures；新增 consumer-version mixed fleet/rollback 拒绝与 fork cross-owner/attachment/cancellation 测试。代码与隔离脚本可自主完成；真实模型、费用账单、fleet drain、部署开关由 operator 提供环境与验收。

## 2. Context / token use

- **当前路径：** `packages/dsh-host/standard-preset.mjs:apply` 加载锁定官方 standard preset，保留原 compaction/planning/delegation groups；`BudgetedModelStreamQueue` / `budgetedModelStream` → Gateway `ModelBudgetLedger`；`ModelBudgetRequest.purpose` 包含 `compaction`。`packages/session-adapter/checkpoint.js` → Gateway `harness/session-checkpoints.ts` 记录持久 Session checkpoint。`projectSessionFrame` 目前只映射 assistant text/reasoning、tool call/result、assistant message；没有 compaction/token/cache 专用投影。
- **证据边界：** 原生 compaction 可用与预算覆盖不等于产品可见 compaction。usage 结算和 checkpoint 有单元/SDK 脚本证据；未发现公开产品对“压缩前后 token、缓存 hit/read/write、图像结果归档及恢复”的闭环契约。本次未执行测试。
- **剩余闭环：** 从真实原生事件/usage 到 owner-readable 时间线与 token/cache 明细；图像工具结果压缩后原 artifact 仍可追溯；短 checkpoint 的读取/重启恢复与 token 展示不能伪造/归零。没有 provider 字段时显示 unknown，费用不能由估计 token 代替。
- **下一代码契约：** 在 `packages/session-adapter/index.js` 的原 stream 只读旁路、`packages/gateway/src/harness/session-event-projector.ts`、现有事件 schema/reducer 与 `web/workbench/` 原时间线中接入 `{session_ref, run_id, native_seq, kind:'compaction', before_tokens:null|integer, after_tokens:null|integer, checkpoint_ref, artifact_refs}`；usage 增加 provider 原始可验证 cache 分项（缺失保留 null）。必须先审查锁定 SDK 实际事件格式，不发新模型请求来取得展示数据。
- **依赖/验证：** 依赖原 native seq、owner/run binding、artifact storage。新增 projector 不认识字段拒绝/忽略、重放去重、owner 隔离、image reference retention、无 usage 不报零、压缩后 restart fixtures；模型预算现有 `model-budget-stream` / `model-budget` 回归。自主完成投影与本地实际 SDK fixture；真实 cache 计费及多模态 provider 需要 operator/provider 证据。

## 3. Models / routing

- **当前路径：** `createHostProfile` 的 trusted `workbenchModel` → `createBudgetModelSelector` → `llm.resolveCallConfig` → 严格 provider/model 相等检查 → `agents.selectForNextRequest`。`workbench/model-budget-policy.ts:normalizeModelBudgetPolicy` / `WorkbenchBudgetPolicy` → `ModelBudgetLedger` 每 attempt reserve/dispatch/settle/unknown；`auxiliary-model-call.ts` 包含辅助调用；`packages/web-decision/web_decision/model_route_pin.py` 保留 web decision 路由。独立 `src/provider.mjs:modelProvider` 仅一个 OpenAI-compatible streaming endpoint。
- **证据边界：** 固定路由与逐 attempt 预算已有源码及测试；固定路由不是兼容性筛选、健康路由或 fallback。不能把路由白名单当作 health/模态支持证明。真实 provider 和账单未在本次验证。
- **剩余闭环：** trusted route catalog 的上下文/模态/reasoning 兼容验证、只读健康检查与明确 operator fallback policy；失败的原 attempt 保留未知费用，只有确认可重试的失败才可新建 attempt。judge/compaction/web 等全部计入原预算，保留 DSH high reasoning。
- **下一代码契约：** 扩展 `packages/gateway/src/workbench/model-budget-policy.ts` 与 `packages/session-adapter/budget-model-selection.js`，新增兼容描述 `{provider,model,modalities,context_window,reasoning_modes,health:{status,observed_at},revision}`。选择结果 `{route,policy_revision,reason,attempt_id}` 只能来自 trusted policy，不接受 tool/model 指定 URL/credential；跨 awaited resolve 再验证 policy/lease。先做兼容拒绝与健康可见性，再在原 DSH 选择服务接合法 fallback，不增加 Gateway planner。
- **测试/依赖/人工：** 复用 `budget-model-selection.test.mjs`、`model-budget-stream.test.mjs`、Gateway `workbench/model-budget.test.mjs`、`auxiliary-model-call.test.mjs`、Python route-pin tests；新增 image/text mismatch、context bound、reasoning preservation、health stale、unknown attempt 不重复和每次 fallback 单独 hold。catalog/guard 可自主实现；health probe 目标、凭据、实际 provider 特性与费用由 operator 验证。

## 4. Tools / concurrency

- **当前路径：** 原 DSH standard preset/registry → `packages/session-adapter/workbench.js` / 原 host 工具 → `packages/gateway/src/workbench/routes.ts` / `execution.ts`，租约、预算、native child reservation/delegation 都有现成模块。`BudgetedModelStreamQueue` 序列化同 Session 主/辅助 stream；`harness/worker-pool.ts` 管 Worker 并发。`native-operation-observer.js:createNativeOperationObserver` 对既有 request 调 `universe_get_state`，不是重新发出动作。独立 `src/agent.mjs:Agent.perform` 按模型 tool_calls 顺序执行，只在当前进程 Map 去重 tool call；`src/tools.mjs` 通过 approve 执行写入/浏览。
- **证据边界：** 有原 native scheduler/parallel/cancel/return fixtures、model queue tests；跨 Worker 并发不证明所有工具依赖顺序与副作用持久回执。独立 runtime 内存 Map 在重启后不构成 durable effect ledger。
- **剩余闭环：** 清楚区分纯读/可重入/外部写工具的 schema、依赖、并发冲突键与未知结果；受权副作用必须有原 operation receipt，不能因丢 ACK 重复。原生工具未返回事实时保持 unresolved，而非把 tool/result 当成功。
- **下一代码契约：** 在原 `workbench/execution.ts` / adapter 工具边界接入 registry metadata `{tool_id,schema_revision,effect:'read'|'write',conflict_keys,depends_on,approval_scope}` 与既有 execution receipt `{run_id,session_ref,call_id,operation_id,state:'accepted'|'succeeded'|'failed'|'unknown',result_refs}`；依赖和冲突控制应使用原 DSH scheduler，不新建并行 scheduler。独立 runtime 如要求重启后副作用恢复，扩展 `src/store.mjs` 持久 receipt 并在 `Agent.perform` 原调用前后 CAS；不能以简单重试兜底。
- **验证/人工：** 新增相同冲突键串行、独立纯读并发、父取消、批准撤销、工具已执行但响应丢失/重启后不重复。保留现有 native operation/worker-pool 测试。metadata、receipt 和本地假工具可自主实现；真实浏览器/发送/桌面不可逆写验收依赖对应服务及 operator。

## 5. Browser

- **当前路径：** 独立 `src/tools.mjs:createTools` → coalesced `browserPromise` → 每 conversation `newContext` → request origin allowlist → approve → read/click/fill → 文本结果；`browserBusy` 防同 conversation 并发，点击异常返回 `browser_action_outcome_unknown`，`close()` 关闭 contexts/browser。工具描述明确 `No persistent login profile`。扩展服务 `packages/gateway/src/server.ts` `/v1/capabilities` 明确 `browser_interaction:false`；原 DSH web/外部 universe bridge 及 operation observer 的存在不能改写此产品声明。
- **证据边界：** 有 root tools/agent 测试；目前没有持久 profile、截图 artifact、控制发现、健康/断连恢复与 Gateway/workbench 接线的完整本地验收。不得把 Playwright 依赖或上游 web bundle 当实现完成。
- **剩余闭环：** 真实拥有者绑定 browser session/profile 生命周期、初始化失败和进程断连重建、截图/控制发现、批准覆盖、故意 close 后不自动复活、未知 click 仅 inspect 不 replay。持久 profile 不进入公开库。
- **下一代码契约：** 保留原 browser service/DSH web 路线，先在 `src/tools.mjs` 提取可注入 browser lifecycle adapter（或原 DSH host 相同适配位置），接口 `{initialize(scope),health(scope),snapshot(scope),discover(scope),act(scope,expected_revision,approved_action),close(scope)}`；scope 含 owner/conversation/session，snapshot 返回受管 artifact_ref + 页面 revision，action 绑定唯一当前控件和批准摘要。Gateway route + workbench UI 只有真实 ready 才发布 browser capability，不把独立 runtime 合同静默搬到 extended service。
- **验证/依赖/人工：** coalesced launch、launch reject 再试、owner/profile 隔离、stale revision、close/no resurrection、browser crash、未知 click、screenshot lineage/privacy；使用本地页面/隔离 profile。可自主实现 adapter/fixture；真实登录 profile、外部网站权限和生产 browser host 由 operator 提供。

## 6. Computer Use / desktop

- **当前路径：** 仓内没有发现 repo-owned desktop driver/protocol、OS permission API、coordinate transform 或 desktop action route。`native-operation-observer.js` 的 `universe_execute` 只是读取既有 leaf execution 事实；不能据此声称桌面控制。`createHostProfile` 禁止 profile 名 `desktop`，并不构成桌面能力。上游锁文件中平台工具依赖同样不证明产品链。
- **剩余闭环：** 原 desktop/native service 的 authenticated discovery → OS permission → monitor/window snapshot → DPI/坐标映射 → approval → action receipt → disconnect/reconnect observation；browser 与 desktop 分别展示 capability。
- **下一代码契约：** 新增 `packages/session-adapter/desktop-driver.js` 与 `packages/gateway/src/workbench/desktop.ts`（仅适配已选择的原 driver，不发明 planner）：`describe:{protocol,platform,permissions,displays,connected}`；snapshot `{snapshot_id,display_id,window_id,width,height,scale,coordinate_space,artifact_ref,revision}`；action `{call_id,snapshot_id,expected_revision,target,approval_digest}` → immutable `operation_id` receipt。缺 driver/permission 必须 ready:false；断连后的写操作 unknown，不重放。UI/route/schema 接原 Gateway owner/lease/approval，并把截图纳入原 artifact retention。
- **验证/人工：** 本地 fake driver 契约、DPI 多显示器/负坐标、stale screenshot、cross-owner、权限拒绝、disconnect after accepted、重连只读调和可以自主实现；Windows/macOS/Linux 原生 driver 安装、OS 授权、多屏真实输入与恢复由 operator 在各平台验收。没有 driver 就不能把 stub/HTTP 200 标记 implemented desktop。

## 7. Credentials / auth / network

- **当前路径：** 独立 `src/server.mjs` 限 loopback/Origin、token/CSRF，`src/tools.mjs:allowedUrl` 拒绝非 allowlisted HTTPS/origin/URL 用户信息。扩展 `loadBffConfig` 要求 CSRF/allowed origins/workspaces/internal channel token；Gateway `actor()` 信任 `x-user-id`，内部 routes 验证 bearer；`src/workbench-proxy.mjs` 注入固定 trusted owner。adapter `apply` 要求 loopback/32-byte token，`createHostProfile` 使用 tokenEnv、workspace-write、approval ask。凭据通过 private 环境/文件；未发现完整用户登录/session/credential reference 管理界面链。
- **证据边界：** 原 owner/path/CSRF/internal auth tests 已有。`x-user-id` 是反向代理契约，不能称公网身份认证；前端取得 CSRF 不能证明调用者身份。HTTPS origin allowlist 也不证明 DNS-rebinding/IP egress、redirect 或所有原生工具网络规则已覆盖。
- **剩余闭环：** 明确可信 ingress 与 public identity 的边界、只接受由可信认证代理设置的 owner、credential reference（只回 handle/状态）与 revoke/rotation、模型/浏览器/MCP 的一致 network policy 与 redaction；生产 secrets 不进入 profile、日志、artifact、公开 snapshot。
- **下一代码契约：** 先在 `packages/gateway/src/config.ts` / `server.ts` / `src/workbench-proxy.mjs` 公开 readiness 采用 fail-closed ingress mode：可信代理身份必须来自已认证通道，直接公网 caller 的 `x-user-id` 不授予身份。连接既有部署认证而非随意添加第二用户库。network guard 复用 `allowedUrl` 思路并覆盖重定向/最终解析地址、原生 bridge。credential status `{reference_id,provider,configured,revoked,checked_at}` 不返回密钥；resolve 仅 server-side，禁止 tool/body 设凭据文件路径。
- **验证/人工：** `packages/gateway/test/security/security.test.mjs` + root security tests；新增伪造身份 header、missing trusted ingress proof、cross-owner、redirect/DNS private-address 拒绝、credential rotate/revoke、错误/事件不含秘密。guard/契约与本地安全测试可自主实现；可信 proxy/IdP、证书、真实 credential store/网络部署验收由 operator 提供。

## 8. Observability / testing

- **当前路径：** `packages/gateway/src/server.ts:/healthz` 仅 `{ok:true,service}` liveness。`session-adapter/index.js` 已有多个 feature readiness；`harness/main.ts` 在 final recovery 启动时检查 history readiness。`HostResourceObservations` / `readHostResourceObservations` 报 gateway shared process interval（GPU/remote inference 明确 null），不能相加称单任务专属资源。`ModelBudgetLedger` 持久 usage/unknown holds；`events/retention-report.ts`、`retention-plan.ts:buildEventRetentionPlan` 只做 protected/nondeletable inventory。profile 默认关闭 session-log-deepseek、session-telemetry-otel；本地 root、Gateway、Adapter、实际 SDK/scripted provider、UI 测试分别存在。
- **剩余闭环：** 聚合可依赖 readiness（DB/schema、原 Host/runtime/source manifest、consumer protocol、model policy、storage、browser/desktop/voice 等实际 enabled feature），脱敏 owner task 状态/unknown outcome 诊断，证据矩阵按 source revision/平台/provider 区分；retention 删除前必须 backup + restore + 原 authority/attachment 证明。不能因 liveness 200、历史绿测试或脚本 provider 就提升真实 provider/deployment 状态。
- **下一代码契约：** 在 `packages/gateway/src/server.ts`、`harness/main.ts`、`harness/session-controller-client.ts`、`packages/dsh-host/` 新增只读 `/readyz` / CLI probe，输出 `{ready,checked_at,source_revision,components:[{name,state:'ready'|'disabled'|'unknown'|'failed',protocol,reason}]}`，禁止读取秘密/创建 Session/模型探测调用；liveness 与 readiness 分开。证据产物保存在不进入发行包的私有测试暂存区，包含 `{source_revision,command,platform,provider_kind:'scripted'|'real',suite,result,features}`，不包含日志原文/用户内容。retention 暂维持 inventory，先实现 isolated restore verification receipt，再让既有 retention policy 消费。
- **验证/人工：** readiness dependency missing、timeout、mixed consumer versions、disabled != ready、redaction、no model/no mutation、跨 owner diagnostics；已有 health/security tests扩展，保留各 suite 独立运行。自主可完成 probe/manifest/本地 matrix runner；真实 provider、压力/费用、跨 OS、backup restore 部署与 fleet rollout 是 operator 验收。

## 可立即交付的优先项

1. 只读统一 readiness/consumer protocol manifest（第 1、8 项），避免启用已有复杂恢复代码时误把旧消费者当兼容。
2. 原生 context/usage/compaction 可见投影（第 2 项），无需新增模型或 planner。
3. trusted route compatibility 与 unknown attempt guard（第 3 项），先不启用自动 fallback。
4. browser/desktop adapter 契约与隔离实际/假 driver 验收（第 5、6 项）；缺 driver 明确 unavailable。
5. 可信 ingress 拒绝/credential 与网络 guard（第 7 项）及 tool receipt/冲突 metadata（第 4 项）。

以上均为待实施或待验收项；本次仅产生此审计文档，没有把任何 capability 状态提升为本地通过、真实 provider 通过或生产接受。

## 最小可实施 browser screenshot 增量（接口待主代理确认）

这只关闭独立运行时的“现有页截图 → 原 run artifact → 用户下载”子链，不能宣布第 5 项或扩展 Gateway browser 完成。

- `src/tools.mjs`：给既有 `browser_action` 增加 `screenshot`，复用 approve；批准描述同时包含截图、URL、生成 PNG 文件。要求 conversation 已有 context/page 且 URL 精确相等，截图不初始化/导航页面。固定 viewport PNG、`fullPage:false`、最多 1 MB，前后检查取消/allowlisted URL；通过内部固定文件名 `browser-screenshot.png`、UUID 文件路径保存，原 `Store.artifact` 绑定 conversation/run，持久化失败或取消清理文件。不要放宽用户上传 `safeName` 白名单。
- 返回 `{artifact_id,name,mime_type:'image/png',size,sha256,url,untrusted:true}`，原 `artifact.created` 不保存图片/base64。`src/agent.mjs` 目前只将 JSON tool result 传给模型；截图像素不会因此成为模型输入，不能宣称模型看见页面。独立 `src/provider.mjs` 没有 trusted modality catalog；真实图像输入应等待第 3 项另行连接。
- `src/tools.mjs:file_read` 目前把任意 artifact 当 UTF-8；对内部 PNG 拒绝文字读取（最好由 trusted stored MIME 区分），防二进制成为无意义模型文本。
- `src/server.mjs` 增加可选 browserFactory 测试注入即可做 API 集成。现有 token-protected `/api/artifacts/:id/download` 按 root realpath/1 MB 验证并以 attachment/octet-stream 返回；这是单用户 local CSRF 边界。`web/main.tsx` 已把同一成功 run 的 generated artifact 显示在对应 assistant message 下，可以直接下载 PNG，无需为此引入新 UI。
- 测试落在 `test/tools.test.mjs`、`test/api.test.mjs` / `runtime.test.mjs`：批准拒绝零 screenshot/零文件、无现有页拒绝、URL 改变拒绝且零导航、取消/超限/写入失败清理、原 run/conversation lineage、模型仅 metadata、重开 snapshot 保留下载、PNG 原字节下载。Gateway `/v1/capabilities.browser_interaction` 保持 false。

### 后续实施记录：独立截图子链（不回写上述审计时点）

主代理确认接口后已在 `src/tools.mjs` 实施 screenshot action，并在 `src/server.mjs` 加入可选 browserFactory 注入。仅捕获已存在 context 的现有 page；不 launch、新建或导航页面。批准包含 URL 与 PNG 留存。返回 artifact 元数据，`Agent.perform` 原 JSON tool history 不包含图片像素。PNG 禁止经 `file_read` 当 UTF-8 读取。

PNG 上限为 1,048,576 bytes；`readArtifact` 相应从 1,000,000 提升至 1,048,576 以支持边界文件下载，用户文本上传/生成上限保持原值。文件以 UUID 独占创建；取消、内容/URL 变化、catalog/event 异常清理文件并回滚同一 SQLite transaction 中的 artifact/event。保存前后校验原 run/conversation。未增加 MIME schema、视觉模型输入、持久登录 profile、Gateway browser capability 或新的 UI。

TDD 初始红测：新增 `test/browser-screenshot.test.mjs` 的 10 例中 9 失败，主要为预期的 `invalid_browser_action`；allowlist 拒绝 1 例已通过。一次初始真实 TCP loopback 尝试因沙箱 `EACCES` 未完成，随后 API 集成采用 Fastify inject，真实运行原路由、Agent、approval、SQLite、文件下载和重开 DB，browser 使用 fake driver；不能声称真实浏览器或 TCP 已验收。最终截图专测 12 例通过，包含实际 PNG 字节、1 MiB 边界、归属、批准、URL/取消 fence、driver 异常/非 PNG、catalog/event 回滚、重启后下载和 metadata-only 模型输入。

相邻回归首次组合执行截图/tools/runtime/api 共 22 例：21 通过，1 个已有 SSE shutdown 测试因相同 loopback `EACCES` 失败。没有更改该 SSE 测试或把它记作通过。未运行全套、build、真实 Playwright/真实模型、多模态 provider 或生产服务；未提交/推送。

主审后移除截图测试中的私有绝对路径；测试目录取 `JOT_TEST_TMP` 或 `os.tmpdir()`，本地执行由外部 TEMP/TMP/JOT_TEST_TMP 指向获准目录。新增终止 run 的红测复现了无 AbortSignal 时仍可截图登记的问题；现按原 runtime 的 queued/running/waiting_approval 活跃状态检查，terminal/unknown 状态拒绝，并在 driver 返回与登记事务中重复检查。独占文件创建、写入、close 均在清理保护中；即使 DB rollback 抛错也执行文件 close/unlink。


## 后续实施记录：内部可信隔离 lead 接线（验收仍有待办）

本轮allowlist只覆盖隔离`jot_workspace`文件及原任务操作接线，不是所有外部工具的总沙箱。
原allowed external tools仍受原role、lease、依赖、Goal和预算约束；不扩展浏览器或外部动作
权限，native work成员仍fail-closed。

本节更新后续工作树状态，不把开头只读审计时点或历史测试改写为本轮结果。
`TrustedWorkRunWorkspaceResolver`、`native-work-runtime` 与原 Gateway/Worker
接线已连接实际 work admission、continuation、保存 Session、完整 selected
objective 和隔离 cwd。只有显式可信配置及原执行/预算 readiness 才安装；默认关闭，
没有生产部署，也没有第二 planner/runtime。原 native work 成员仍拒绝执行，不能退回共享权限。

原 `workbench/execution.ts` 在同步事务外执行 lead 文本 file IO；原短事务内同时提交
isolated result、原 execution proof、独立 isolated subtype 和原 tool response。
回放先读原响应，不重复 IO。完整 `WorkInspections` 冻结真实 base/result manifest、diff、
计划/源哈希和原 call set；原 quiescence、租约、权限、pending/unknown 状态在最终事务复核。
proposal/candidate/current 必须绑定同一完整 inspection；之后的文件调用或重新检查不能
静默刷新旧 proposal。selected objective 来自完整已接受计划，原 planning task objective 不改。

本轮针对性 inspection/business-completion13/13、普通 output/acceptance27/27、
历史 source/response 硬化3/3 通过，typecheck 通过。27 项运行明确排除此前已观察到
loopback 权限失败的 pending-download 个案，没有把它记作通过。root50/50、UI212/212通过；完整Gateway/build/披露的当前结果与首轮失败统一记录于下文，
不替代SDK稳定性门槛。较早一次修正后的实际 installed SDK 两例2/2通过（37.7s）：direct
10条 Messages请求/60 reported tokens，cold wait/reply 11条/66 tokens；后者重启
Host+Worker，保留原 work Session/Goal/occurrence/完整 selected objective。两例均验证
exact1 isolated write、原 native completion、owner验收与immutable artifact交付，
ledger 无 held/unknown/reserved。更早 pending-step 与末尾 fixture 查询失败仍保留失败记录。
官方 typed missing-Session 兼容、GoalBridge lease 保留与readonly observation 分离已修正；
完整 adapter 回归548总/524通过/24既有SDK依赖skip/0失败（2.75s，未设置可选SDK模块
环境）；显式installed SDK两例是另一层证据。package dry-run54文件包含新helper，真实
解包import测试通过。SDK的Messages端点为受控本地脚本，不证明真实provider质量或生产稳定性。

第1/4/8项仍需原 unknown 恢复和 consumer rollout、通用工具副作用/冲突契约、真实
readiness/可观测性及跨平台矩阵；本轮只关闭上述内部 lead 文本 IO 与证据接线子链。
同库 shared + 两个 isolated cycle/version 的完整接受矩阵、授权 native 成员、binary/shell
权限与实际 SDK 完整回归仍待验。完整 diff 产品 UI、apply/unknown reconciliation、
report-memory、autodispatch、保留/Git/部署等见
[当前 native-work 边界](../superpowers/plans/2026-10-17-always-on-discovery.md#current-internal-lead-io-and-frozen-output-integration)。


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
