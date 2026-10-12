# 源码来源与冻结范围

## 保留的可用插件

- 源目录：`../RESUME_AGENT`。
- 扩展版本：0.7.28。
- 归档：`../archives/resume-plugin-0.7.28-2026-10-07-source.zip`。
- 归档 SHA-256：`d76d4a80af8798540cef713823cc328b153e382336e850ab07cffcc9761e6748`。
- 校验依据：`reports/stable-baseline-manifest.json`，保存归档中 206 个文件的哈希。

复制了表单扫描、控件适配、页面事件提交、资料编辑、资料账本、映射校验和映射模型适配器。没有复制 `.env.local`、私有资料导出、浏览器数据、依赖目录或旧运行日志。

原来的 `runRealForm` 和固定循环 runner 未复制到新项目。新真实运行入口只导向 Node 服务中的 `createResumeAgent()`。

资料 Schema 和少量表单帮助函数来自原插件已有的 `src/vendor/formfill` 快照。其来源说明和 GPL-3.0 LICENSE 随源码保留。没有编辑另一个窗口维护的 FORMFILL_RESEARCH 项目。

## 本次新增

- `src/agent`：动作模型、工具参数、策略与 LangGraph 图。
- `service`：独立设置服务、Chrome 反向 RPC 和受保护的模型配置。
- `agent-extension/src/worker.js` 与 popup：新的浏览器启动器与 Agent 工具端。
- `src/runtime/protocol.mjs`：双方共享的严格工具通信契约。
- `web`、`tests`、`scripts`、`docs`、`reports`：设置、虚构表单、检查与学习记录。

新扩展 ID：`lmnbaojjicagbfcaanndkmchmeiaiddm`。原扩展 ID：`lmgllncoafdghpeaoephgojaifocofbo`。两个目录与资料库独立。

## 参考版本

Browser Use GitHub HEAD 在 2026-10-07 调研时为 `914c59bdd4acd50e9628a97a96a3919313aebc85`。文档使用对应提交的永久链接。参考其流程和架构；本阶段未复制其 Agent 实现，也未把其 Python SDK 作为真实网页运行依赖。

LangGraph 版本 1.4.20、LangChain Core 1.2.17。精确依赖与完整性由本项目 `package-lock.json` 记录。
