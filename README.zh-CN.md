# Jot

**一个轻量化 AI Bot，帮你聊天、处理网页任务和交付文件。**

[English](README.md) · [技术栈](TECH_STACK.md) · [部署与配置](DEPLOYMENT.md) · [Agent 说明](agent/README.md) · [接入方案](INTEGRATIONS.md)

Jot 用简洁的界面连接提问、执行和结果：看到任务进度，确认需要授权的动作，拿到可下载的文件。默认深色，支持浅色切换。

## 功能

- 配置模型后可进行真实对话与工具调用的本地 Agent。
- 多会话、SQLite 持久化、事件回放与实时回复。
- 取消任务、操作确认、新文件生成和下载。
- 显式允许的网页读取、可选搜索和隔离的浏览器操作。
- TXT、Markdown、JSON、CSV 文件上传与新文件生成。
- 独立 Demo 模式：使用合成响应，清楚标注，不调用模型或外部网站。
- 扩展后端：项目、归属校验、批量进度、事件恢复、文档任务和可选语音。

本地运行版不依赖扩展服务。扩展功能需要自行配置运行服务、模型和工具端点；有接口代码不代表外部服务已安装。

## 启动

安装 Node.js 24 或以上版本。代码首版位于 `feat/standalone-agent`；如果当前分支只有文档，先切换到该分支。

```sh
git clone --branch feat/standalone-agent https://github.com/kazwskjack/jot.git
cd jot
npm ci
npm run build
npm run demo
```

访问 `http://127.0.0.1:3030`。真实 Agent 使用时，将 `.env.example` 复制为 `.env`，填写模型地址、名称和密钥，再运行 `npm start`。模型需要支持流式 Chat Completions 与函数工具。

读取网页前配置允许的 HTTPS 来源；浏览器功能需安装 Chromium 并设置 `JOT_BROWSER=true`。文档扩展需要 Python 3.12 和按需安装的文档处理依赖。

最低与推荐硬件、完整安装方式、参数与重部署步骤见 [部署与配置](DEPLOYMENT.md)。

已包含、外部依赖和待接入能力见 [功能状态表](FEATURE_MATRIX.md)。开发经历见 [DEVELOPMENT.md](DEVELOPMENT.md)，调度、去重、事务、恢复等机制见 [ALGORITHMS.md](ALGORITHMS.md)。

## 工程选择

React 和 TypeScript 用于界面与接口约束；Fastify 负责 API；SQLite 保存会话、任务和事件；SSE 传递进度与回复；Python 文档工作进程处理文件。选型原因、优势和限制见 [技术栈](TECH_STACK.md)。

原创代码与文档采用 MIT 许可证，第三方依赖保留各自许可。
