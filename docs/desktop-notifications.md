# 桌面任务通知

当前源码已有主进程 Notification、可信主 frame IPC、原任务/occurrence/generation/event 身份、设备偏好、任务事件选择、时区免打扰、限频和保留历史。通知点击与动作仍只打开原 task_id/occurrence_id，不创建任务或执行任务。

## 并发和撤销边界

通知在首次异步读盘前登记原身份，重复 show 不另建原生通知。准备中、等待原生 show 和已显示的通知使用同一可撤销记录。dismiss、任务撤销、非 granted 权限、偏好变化、主 frame 文档导航、renderer 退出、窗口销毁和应用退出均撤销相应记录；旧的异步继续不能重新激活已撤销的通知。关闭后的迟到点击、动作和 show 不再打开任务或重建 active 状态。已显示过而随后撤销的 seen 身份可继续保留，不授权重放。

同一 stateStore 的初始化、seen 和偏好修改共用进程内读改写队列，每次重新读取最新文件状态后再写入。失败不阻塞队列的后续调用，持久文件仍沿用原 JSON 校验、临时文件和原子替换。该队列不提供多进程文件锁；单个桌面主进程拥有该 store。读权限、平台原生通知和 OS 权限设置不由这个队列替代。

偏好更新开始即关闭旧通知，更新期间不接收新 show；更新失败不会假装保存成功，仍可使用原 IPC 读取实际偏好。原生 show 后才按最新权限、策略和 seen 再次核对并记录；文件写入失败会关闭原生通知并返回 false。OS 已经短暂展示的通知无法回收用户已经看到的内容，记录和 OS 展示不是跨系统原子事务。

## 未完成范围

M20.04 尚未完成。工作台顶部已接入当前设备的通知设置及原菜单入口，原 showTaskNotification/initializeNotificationState 任务事件循环现已接入。旧 occurrence 证明、跨 origin 游标迁移、结束等待历史的归档、完整 OS 权限及 M24 发行/回退范围仍未完成。不能用轮询猜测完成、旧页面状态、WebPush 投递或内存点击记录冒充原任务完成与系统权限。

本次为底层源码增量，未运行测试、构建、Electron、浏览器或 OS 通知，也没有安装、重启或部署。

## 设备偏好界面

工作台顶部的“桌面通知”和原生菜单通知设置打开同一个设备面板，不切换或丢弃当前任务/对话。普通浏览器没有原 jotDesktop bridge 时不显示该入口。面板使用原 readNotificationPreferences/setNotificationPreferences/readNotificationPermission 和权限事件；字段校验复用主进程相同的通知策略，不另存浏览器偏好。

设备开关、时区免打扰时段只通过明确保存写入。编辑中不会申请权限；保存回执校验后显示主进程确认值。结果不明时保留草稿并禁止再次保存，用户重新读取已保存状态后才恢复编辑。保存期间使用独立 pending 标志，与工作台 pending 合并，互不清除。关闭面板将焦点返回原按钮，菜单打开则聚焦设置区域。

权限请求是用户点击后调用原浏览器 Notification.requestPermission，再读取主进程的原权限结果；没有自动弹窗、测试通知或 API 探测。设备开关保存为开启后才可申请。显示的 granted/denied/default 是当前应用 origin 的浏览器权限，不能证明 Windows 通知设置、macOS 系统授权、Focus Assist/系统免打扰等允许展示，界面保留这一差异。未增加 OS 设置跳转或假装已经确认全部系统权限。

设备偏好面板本身不发送任务通知，也不根据偏好推断完成。实际事件循环如下；此任务没有运行产品或测试。

## 原任务事件来源账本

Gateway 在原任务 admission 事务内为新 occurrence 保存单独的桌面通知 scope，绑定原 owner/task/generation/task_version/agent/capability_epoch/settings_version/events。它不依赖外部渠道绑定，也不生成渠道 effect。默认事件复用原 TaskNotifications 的 completed；任务事件选择为空则不登记。没有持久 SQL 角色证明时不从内存角色补造授权，不倒推旧 occurrence 的历史 scope。

原通知维护入口每次最多从尚未记录的真实来源中保存 50 个桌面事件，按来源时间与原身份稳定排序；已有记录不占用下次配额。scope、页面变化证明和事件均有不可改写触发器。记录事件不等于发送通知，桌面设备开关和系统权限仍在原主进程判断。

完成来源必须同时有原 wb_task_finalizations 及其原 assistant message，且属于同一 owner/conversation/current occurrence/run；普通 succeeded 状态不算完成。失败来源要求原运行 failed 且不是 OUTCOME_UNKNOWN。待确认来源核对原运行版本、checkpoint、interaction 的 conversation/run、pending 状态和过期时间。页面变化在原监控 admission 事务内核对旧 baseline、新快照 hash、URL 对应证据与 page_change 触发器，再记录最小 hash 证明，不复制页面正文或终端输出。

扫描只接受当前原任务版本/代际、角色 epoch、活动角色和原通知设置版本；暂停、归档、变更角色或通知设置后，不把旧 scope 当作新发送授权。历史不可改写事件本身不能证明当前仍允许发送；后续 feed、发送前核对及撤销必须复用同一来源与 scope 条件。

原事件账本已增加只读任务事件 feed 与逐事件状态查询，已连接 renderer 的原 showTaskNotification，并在每次发送前重新核对原来源。旧 occurrence、旧记录迁移、完整 OS 权限和 M24 范围仍待接续；逐事件原生去重身份已接入下述协议2，不回写历史 seen 伪造已通知。仅审阅和修改源码，未执行 SQL、迁移、任务维护或产品。

## 只读事件分页与当前来源查询

`GET /v1/persistent-tasks/desktop-notifications/events?after_event_id=...` 从当前账户的已保留事件账本按内部不可改写 sequence 升序读取，每页至多 50 项，另读一项判断 has_more。游标只能是同一账户的原 event_id；任务后来失效不会使其历史游标失效。原生序号不在公共接口返回，不用其他账户事件或数量作为游标。没有游标时从本账户保留账本起点读取，这不是自动发送历史通知的指令。

`GET /v1/persistent-tasks/desktop-notifications/events/:eventId` 在同一只读快照中重新读取同一事件及原任务/角色/settings/current occurrence/因果来源。两个接口复用相同的来源检查，不调用维护、不创建事件、不发通知、不取得执行资格。不存在或其他账户的原事件/游标均为 task_not_found，格式错误由原路由校验拒绝。

事件始终保留原 event_id、task_id、occurrence_id、generation、event_kind 和来源 created_at。仍有效时提供最小任务标题、固定说明与明确投影的五字段 task_settings；不传最终消息、页面正文、交互内容或外部渠道授权。失效时 source_status=revoked，candidate/task_settings 均为空，原身份仍可用于撤销。即使一页全部失效也可按 next_event_id 前进，不反复卡在旧记录。

响应含协议1、当前服务端时间及 execution_granted=false。Gateway 和工作台代理均加 private, no-store；公共 types、JSON/YAML API 声明和原 workbench client 已接入。事件读取结果只是该快照的来源状态，不能替代真正发送前的重新核对，也不承诺 OS 会显示通知。

后续 renderer 仍须处理首次连接/历史基线、原生持久去重、同一 occurrence 的多个真实事件、未知结果、源失效及账户/文档撤销。新 candidate 带原 event_id，新原生通知协议2可接收此字段，但旧主进程不支持。现有发送循环拒绝缺少主进程能力确认的旧主进程，不删除事件ID降级发送。旧 occurrence 没有出生 scope 时不伪造历史授权，完整 OS/M24 范围也未结束。本次未运行 HTTP、SQL、任务维护、浏览器、Electron、构建或测试。

## 原生逐事件身份与旧记录

原 notification.show/dismiss 的严格字段集合可额外包含原 event_id（desktop-notice- 后接64位小写十六进制）；显式 undefined/null、格式错误和多余字段均不降级为旧请求。没有 event_id 的旧请求仍沿用原四字段身份与键，不自动创造事件ID。新请求把事件ID加入相同身份键，运行中去重、撤销和 seen 写入共用同一个键函数；相同任务/occurrence/代际/种类的不同真实事件不再互相覆盖。

持久状态读取接受原 version1，以及保留旧条目并允许原事件ID的新 version2。默认及纯旧请求保留原 version1；第一次确认显示带事件ID的通知时才写 version2。旧条目原样保留在原2000条上限内，不猜测它对应哪个新事件；重复相同新身份仍拒绝。version1文件不能夹带新事件字段，version2不会被新程序降回version1。未知版本或损坏内容继续拒绝，不清空历史。

新增只读可信 IPC notification.capabilities，通过原 preload readNotificationCapabilities 查询实际主进程 runtime 的 event_protocol（2表示支持逐事件身份，旧/未提供能力的runtime为1）。它不是preload自己声明支持；旧主进程不认识此通道时调用失败，后续发送入口必须停止，不能删掉事件字段改用粗粒度旧键。偏好面板仍兼容原三种偏好/权限方法。

event_protocol2只确认身份能力，不是当前来源授权。新主进程额外通过下述delivery_protocol1区分逐事件发送回执；旧布尔返回仍不能证明从未显示。历史事件继续需要原来源重新核对。

新程序保留旧状态；旧程序无法读取已写入的version2，会按原未知格式规则拒绝，而不是覆盖成空文件。此阶段没有运行或改写用户的实际通知状态文件，也没有安装或部署；回退兼容范围保留在后续发行/恢复工作中。

## 逐事件发送回执

原 notification.show 对不含 event_id 的旧请求仍返回原布尔值；带原 event_id 的请求返回严格的 `{protocol:1,event_id,status,reason}`。主进程实际能力查询同时返回 event_protocol2 和 delivery_protocol1。仅有身份协议、缺少回执或只读核对协议、旧布尔结果或畸形/错事件回执均不能作为新流程的确认，前端不会删除事件ID再尝试旧接口。

- shown：原生 show 事件后，原共享状态队列已确认写入相同事件 seen；不代表 OS 用户实际阅读了通知。
- already_seen：相同身份已在已确认 active/seen 中，不重新显示。
- deferred：本次调用尚未调用原生 show，明确的权限/设备设置/免打扰/限频或准备失败阻止了发送。重试仍须重新核对原来源、任务设置和设备权限。
- in_progress：相同事件已有原 pending 调用，不另建通知；不能当作已显示或授权再次发送。
- unknown：已经请求原生 show，但关闭、失败、超时、撤销或持久化失败导致结果未确认；不能据此自动重发，也不能把它写成已显示。

回执的事件ID必须原样匹配，新客户端严格区分成功/已存在的空reason，以及deferred/unknown的固定原因代码。原生 show 调用前即设置本次派发标志，抛错也保留unknown；show之后再发现权限/策略失效只会关闭并保留unknown，不改成“从未发送”。读盘等准备错误发生在该标志之前才返回deferred。

这套主进程回执本身不提供跨重启的全部请求日志。renderer现已在调用前持久保存原事件尝试，按原事件恢复核对seen与来源，保留未知而不自动重发；有明确未发送回执时才可在当前来源仍有效的前提下延后。实际循环和未知尝试保留现已接入；结束等待历史归档与旧 origin 迁移仍待接续。本任务未运行原生通知、产品、测试或部署。

## 工作台发送与恢复循环

工作台账户会话内挂载 useDesktopTaskNotifications，普通浏览器无原生桥接则不启动。循环要求实际主进程 event_protocol2、delivery_protocol1、inspection_protocol1 及当前 origin 的 Web Locks；旧版本不回退发送。原可信 notification.inspect 仅按原事件身份读取 active/pending/seen/not_recorded，不执行或重发；not_recorded 不能证明从未展示。

原账户 hash 作用域的 localStorage 保存原 event cursor、首次连接服务端时间基线和最多64条 pending身份/状态，不存候选正文或密钥。Web Lock 串行同 origin/账户的写者；每次保存核对原字节并回读确认。损坏/未知格式、写失败、外部覆盖或协议不符停止新发送，不静默清空。首次开启采用首次服务端读取时刻为基线，不推送此前历史；原账本仍按50项分页扫描，游标只越过已保存或已明确跳过的记录。普通同 origin 重载沿用原基线和游标，离线后产生的原事件仍可继续分页。

每轮先读取原设备偏好，最多轮询核对8条待处理记录，位置轮转避免只处理前几条；再读取一页原事件。来源校验、候选及原task_settings逐字段核对身份与策略，来源失效则按原身份撤销。尚未有尝试的queued记录只有在原生核对后、最新服务端来源仍有效且设备开启时，才先保存dispatching，再调用原生show。shown/already_seen转为已显示观察；原生明确deferred才允许回到queued；unknown/in_progress、异常/错回执/中断均只核对，不重发。已确认但不再active的seen可从本地待处理队列移除；这不删除原生seen。

HTTP读取有12秒子AbortController，离开账户或超时会释放请求；原生等待也有限时，结果不明保留原尝试并停止该发送流程。源网络错误不会授权发送，会尝试关闭已知通知并保留记录待再次核对。定时器/监听器在释放时清理；状态与计数不变不反复触发工作台渲染。账户切换、手动重新核对、卸载或文档离开会按原身份撤销已知在途/显示记录，主进程原导航和renderer终止处理仍独立保留。

工作台显示未确认/队列满/不可用状态及“重新核对通知”；该按钮不重发不明记录。达到64条时保留未读游标，不丢弃记录继续吞新事件。用户仍可使用原通知的点击/动作或结束等待历史入口打开原task/occurrence，不创建或执行任务。偏好/权限不会自动申请，无测试通知。

当前保留边界：结束等待现可释放未知队列位置，但本地未知历史上限64条，归档仍未接入；首次连接时间基线不是旧事件补发；localStorage/Web Lock受origin约束，发行时若端口/origin改变，跨origin持久游标迁移尚未实现；无Web Locks版本不会发送。旧无出生scope事件不伪造原权限，完整OS权限、撤销失败的系统表现和M24回退尚未验证或完成。源码接入不等于已运行，未执行测试、构建、HTTP、Electron或OS通知。

## 保留未知并结束等待

状态面板增加明确的结束等待动作，只选择该账户在界面上已知的未确认原事件，不处理queued或已确认shown记录。操作在原Web Lock内先把原身份持久保存为ending，再保存到独立ended未知历史并从pending移除；游标与历史基线保持不变。若在两次写入之间退出，重载会接续原ending意图，不重发原通知。

历史仍表示结果未知，不伪造shown/failed/cancelled回执，也不写原生seen。保存后尝试按原身份撤销通知，撤销异常或结果不明不阻止结束等待，更不声称原操作已经取消。该收尾可在来源不可用时处理，不依赖新任务执行授权。账户身份失效不继续写入另一个账户；后续回到原账户可沿原记录恢复。

浏览器journal格式2增加ended，兼容读取原格式1的游标、基线和每一条pending；读取时只在内存补空历史，实际保存时才采用格式2。不为旧格式伪造结束记录，未知格式和损坏数据继续拒绝。pending与ended中原event_id不可重复，预留ending后的历史总数也不能越过上限；读取/写入仍有原字节冲突与回读确认，记录限额为128KiB字符上限。

pending最多64条，ended也最多64条且不自动轮替覆盖。历史剩余空间只够部分处理时，按钮明确显示将处理前几条；没有空间时停用动作并保留尚未处理的记录，后续需要归档功能。历史可展开查看原task/occurrence/event身份并通过原任务打开流程查看；结束动作后返回状态区域焦点，若状态区域消失则返回原通知设置按钮，不抢走其他编辑区焦点。

来源事件重复读到时会核对pending或ended的原身份，ended不会重新排队；只读“重新核对”不撤销结束事实。首次连接、正常同origin恢复、64条容量和源失效处理沿用已有逻辑。

已追踪 apps/desktop/backend.mjs：本地服务明确使用127.0.0.1随机端口0，再把实际origin提供给窗口。这意味着localStorage/Web Lock不能保证跨次启动沿用同一origin，不能用固定端口或仅改界面基线掩盖迁移缺口。下一步须接入原生userData/原后端持久存储及其现有写入/发行保留规则，保留当前origin未知和结束等待记录后再迁移。完整OS/旧occurrence/回退范围仍未完成。本次仅修改与审阅源码、提交Git，未运行产品、测试、构建、迁移或部署。
