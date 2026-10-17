# 离线 release preflight

`scripts/release-preflight.mjs` 为克隆后的源码、构建产物和已提供的运行配置做只读结构检查。它补充 `scripts/verify-public.mjs` 的公开源码扫描；不扫描 secret、不安装、不构建、不启动服务、不创建数据库、不调用 provider、不验证部署成功。

在仓库根目录执行：

```powershell
node scripts/release-preflight.mjs --profile standalone --stage source --json
node scripts/release-preflight.mjs --profile gateway --stage source --json
node scripts/release-preflight.mjs --profile host --stage source --json
```

默认 `--root` 为脚本所属仓库根目录，默认 profile 为 `standalone`、stage 为 `source`。可用 `--root <checkout>` 检查另一个目录；输出不包含该路径。Node 版本从当前进程读取，不运行 shell、不加载被检查 checkout 的模块。

运行配置在操作者已经加载到**当前进程环境**后检查。工具不读取 `.env` 正文，不尝试发现/加载私有 env 文件，也不把密钥作为 CLI 参数接收：

```powershell
node scripts/release-preflight.mjs --profile standalone --stage runtime --cwd E:/codex/jot-workspace --json
node scripts/release-preflight.mjs --profile gateway --stage runtime --cwd E:/codex/jot-workspace --json
node scripts/release-preflight.mjs --profile host --stage runtime --cwd E:/codex/jot-workspace --host-profile-dir E:/codex/private-host/profiles/jot --json
```

这些路径是示例，不会由命令创建；`--cwd`、Host profile 与配置里的目录必须预先存在。没有任何选项会生成默认凭据、私有目录或数据库。不要把真实环境值写到命令行、报告或公开仓库。

## 检查边界

| Profile | Source | Runtime 追加检查 |
|---|---|---|
| standalone | 根 manifest、Node engine、lock 的根 name/version/direct dependencies、`src/server.mjs` | 根 direct dependency package version、非空 `dist/index.html`、显式绝对现存 cwd、model URL 形状与 model presence |
| gateway | Gateway manifest、Node engine、独立 lock、API/Worker 源入口与 OpenAPI 文件 | Gateway direct dependency versions、API/Worker compiled JS、schema/OpenAPI 构建副本、cwd、CSRF 最小长度、internal token/workspace presence、origins、loopback adapter URL、显式 DB parent/file root/harness cwd/token file，以及 steering/recovery/steering reconciliation/final reconciliation 开关依赖 |
| host | preparation manifest、Node engine、官方 lock 的根依赖/SDK 版本与实际 preparer/preset 源码契约一致、preparer/preset/adapter 源入口 | 显式 prepared profile、声明官方版本、与仓库完整 pinned lock 相等、config/patch 文件、已安装官方 package version/bin 与 launcher 文件、adapter token 最小长度、cwd |

Node 要求来自各自 manifest，而非统一改写为 24：当前 standalone 是 `>=24`，Gateway 是 `>=22`，Host **preparation 工具**是 `>=24`。Host 锁内官方 launcher 未声明 Node engine，此工具沿用本仓库 preparation 要求，不替官方发布者证明运行兼容性。Gateway 检查的是编译后的 JS 运行入口；不以本工具的成功保证直接执行 `.ts` 测试时的 strip-types 支持。支持的 engine 合同为当前仓库所用 `>=major[.minor[.patch]]`，未来出现其他 semver range 将明确失败 `ENGINE_CONTRACT_UNSUPPORTED`，需审阅后扩展。

Token 文件仅 `lstat` 检查为非空普通文件，不读取内容，不证明 token 有效、权限安全或与 Host 一致。配置 presence/形状不证明身份、provider 可用性、费用、凭证正确、代理鉴权、owner、registry、consumer rollout 或权限已被接受。工具不检查真实 `.env` 是否与调用环境一致。

Host 版本不另维护第三份固定字符串：只读有界源码，提取 `create-profile.mjs` 的官方 dependency 与返回 runtimeVersion，以及 `standard-preset.mjs` 的 manifest.version guard，三者与锁内根依赖/SDK 版本必须一致。提取不到唯一的当前 literal 合同则 `LOCK_SOURCE_CONTRACT_MISMATCH`，源码重构后需同步审阅本检查器；不会 import/eval 候选 checkout 或 private profile。这是静态一致性检查，不是 JavaScript 语义证明。Gateway final reconciliation 明确要求原 input recovery 和 steering 同时启用，开启这些开关仍不证明生产 rollout 获授权。

Gateway runtime 采用显式 DB/file root/harness cwd/token file 部署策略，拒绝依赖 Linux 默认路径；即使运行时代码有默认值，也要求操作者明确配置。DB parent 必须存在，但 DB 本身可不存在；本工具不打开它。`GENERAL_AGENT_FILE_ROOT` 需显式配置，不采用 legacy upload-root alias。没有探测目录可写性、ACL、符号链接祖先、SQLite 支持/迁移、数据库与文件一致性、端口、Python/Office、浏览器、可选 voice/delivery/model-budget 配置及其额外服务。

文件检查只是指定入口非空、普通文件，依赖检查只是直接依赖 manifest 的版本相等；不遍历/校验全部已安装依赖和 transitive binary、不执行 npm、不提供 supply-chain/构建完整性或签名证明。HTML 引用的全部 assets、JS import graph、模板、Office/file-worker 可执行环境均未穷举。Host 检查不解析执行 Cordis 配置，也不审计实际模块组合、patch 来源、配置引用路径、原生权限或 preset registry；继续遵循 `packages/dsh-host/README.md` 的私下 composition 审计。完整 pinned lock 相等只证明所读 JSON 与仓库锁一致，不证明已安装字节完整。

## 机器协议与退出码

`--json` 仅向 stdout 输出一行 JSON，无时间戳或路径；报告顺序固定，未通过检查不会打印环境值、错误原文、堆栈或文件内容。

```json
{"protocol":1,"profile":"standalone","stage":"source","scope":"offline_structure_only","ready":true,"checks":[{"id":"source.manifest","status":"pass","code":"MANIFEST_READABLE"}]}
```

该片段省略了其余 checks；真正结果包含全量检查。`ready` 仅表示所选 profile/stage 的全部离线检查通过，不是健康状态、安装完成或发布许可。集成者读取 `protocol`、`profile`、`stage`、`scope` 和每项稳定 `id/status/code`，不要依赖人类摘要。没有 `--json` 时输出固定文字和同样的检查码；参数错误仍输出固定 JSON。

| Exit | 含义 |
|---|---|
| 0 | 所选离线检查通过 |
| 1 | 条件缺失/不匹配，或无法完成检查（固定 `INSPECTION_FAILED`） |
| 2 | 未知 profile/stage/选项、重复选项、缺失参数等用法错误（固定 `INVALID_ARGUMENTS`） |

不要把传入的 `.env` 值塞进报告元数据。profile/stage 是固定枚举，检查 id 不包含读取到的 package 名称、路径、URL、凭证或无效参数值。

## 定向验证

```powershell
node --test scripts/release-preflight.test.mjs
```

测试的全部临时文件位于仓库 `.test-tmp/release-preflight/`，并清理各自独占 case 目录。覆盖 source/runtime 边界、各 profile Node 要求、错误版本/manifest/range、缺构建产物、相对/缺失 cwd、Gateway 必需配置与 adapter URL、Host pin/lock/launcher、敏感 fixture 不出现在结果、`.env` 不被使用、不创建 `.data`/DB，以及 CLI 的 0/1/2。它使用本地 fixture，不验证 provider/运行服务。未要求或执行全套构建/测试。
