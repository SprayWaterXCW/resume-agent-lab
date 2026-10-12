# Browser Use 对照与差距

调研日期：2026-10-07。GitHub HEAD：`914c59bdd4acd50e9628a97a96a3919313aebc85`。

## 参考了什么

Browser Use 的 [`Agent.step()`](https://github.com/browser-use/browser-use/blob/914c59bdd4acd50e9628a97a96a3919313aebc85/browser_use/agent/service.py#L950) 先准备浏览器状态，再调用 `_get_next_action()`，随后 `_execute_actions()` 和后处理。这形成了依据页面反馈持续决策的循环。

其 [`multi_act()`](https://github.com/browser-use/browser-use/blob/914c59bdd4acd50e9628a97a96a3919313aebc85/browser_use/agent/service.py#L2494) 会在动作序列中检查页面变化，避免队列里的后续动作继续操作旧页面。我们的执行前快照核对和单项动作执行借鉴了这个原则。

[`system_prompt.md`](https://github.com/browser-use/browser-use/blob/914c59bdd4acd50e9628a97a96a3919313aebc85/browser_use/agent/system_prompts/system_prompt.md) 为模型提供上步评价、记忆、当前目标和动作的结构。我们记录公开的上一轮评价、下一步目的和工具反馈；没有请求或展示模型的隐藏思维链。

[`MessageManager`](https://github.com/browser-use/browser-use/blob/914c59bdd4acd50e9628a97a96a3919313aebc85/browser_use/agent/message_manager/service.py) 负责组织任务、页面状态与历史。它是后续上下文管理的重要参考。

## 逐项比较

| 维度 | Browser Use 参考实现 | 原可用插件 | Agent Lab 0.1.6（M1 / M2） |
| --- | --- | --- | --- |
| 下一项动作 | LLM 从动作模型选择 | 程序遍历已规划字段和经历 | LLM 选择九类工具与目标 |
| 页面观察 | 浏览器状态、DOM、截图等 | 表单元数据扫描 | 逐轮扫描；模型可选 inspect_field 观察公开选项与组件就绪状态 |
| 工具实现 | 工具注册、浏览器会话与动作执行 | 可靠的表单控件适配器 | 用 WebSocket 连接普通 Chrome 的原有可靠工具 |
| 错误反馈 | 动作结果进入下一步上下文 | 预先编码的恢复流程 | 错误码进入模型决策；模型选重试、规划、其他字段或人工处理 |
| 页面变化 | 动作序列中检测页面变化 | 结构变化后程序重新规划 | 动作执行前检查快照；结构变化使计划失效，再由模型决定 |
| 动作批次 | 支持序列执行及序列终止 | 字段循环由程序安排 | 解析最多八个调用，仅执行模型的第一项，其他项延后 |
| 状态和记忆 | AgentState、历史和消息管理 | 扩展任务槽和执行记录 | LangGraph StateSchema、结构化历史、凭据及模型尚未解决的核对请求 |
| 人工协作 | 暂停和继续等控制能力 | 停止、手工处理 | LangGraph interrupt / Command；暂停可补资料，版本变更后重新观察和规划 |
| 持久恢复 | 源码有注入 AgentState、历史等机制；部署方式决定恢复边界 | 后台中断后重新开始 | 当前 MemorySaver 仅内存，未完成进程重启续跑 |
| 跨网站动作范围 | 通用浏览器动作与页面内容操作 | 简历表单填写 | 限定简历工具集，暂未加入视觉定位、通用弹窗处理 |
| 业务验收 | 任务历史、结果及可配置判断机制 | 字段回读与页面状态证据 | 保留原校验；计数来自凭据，服务器是否接收明确标记未检查 |

## 技术选择

我们保留 JavaScript 和普通 Chrome 工具桥接，让已验证的实际写入能力服务于新的模型决策器。Browser Use 是架构和源码参照，目前没有把 Python SDK 插入 Chrome 的真实运行链路。

实际安装并用于运行的是 `@langchain/langgraph@1.4.20`。`@langchain/core@1.2.17` 是其核心依赖之一；模型供应商接口使用现有 OpenAI 兼容协议和独立的动作适配器。当前没有使用 LangChain 的 `createAgent` 包装层。

LangGraph 既能组织工作流，也能组织 Agent。判断应看谁选择业务工具和动作顺序。官方 [Workflows and agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents) 也将预定路径与动态决定过程、工具使用区分开。

## 下一步优先级

1. **普通 Chrome 验收**：通过唯一正常入口检验刷新后的第一轮、跨标签页、控件事件进入页面状态和添加经历。为真实页面结果保留结构诊断。
2. **观察和恢复工具**：已提供 `inspect_field`、下拉候选、组件就绪与逐项错误摘要；继续扩展跨布局证据和真实页面验收。继续禁止任意点击和脚本执行。
3. **上下文管理**：按当前区块投影资料目录，保留重要失败与凭据，减少整页重复发送。记录 token、延迟和模型调用次数。
4. **持久状态与文档重绑定**：先设计敏感信息不落盘的状态模型，再使用 SQLite checkpointer；恢复必须重新观察，写入凭据需要校验。
5. **可靠评估集**：含不同表单布局、动态卡片、下拉菜单、组件回滚、缺资料、声明按钮和刷新中断。分别评估动作合法率、有效覆盖、恢复率和页面状态一致性。
6. **视觉补充和安全动作批次**：用截图弥补 DOM 不足；让模型提出少量动作，执行中按页面变化停止过期队列，减少逐字段的调用成本。

这一阶段建立模型驱动的决策环。0.1.6 真实工具栏运行已验证模型检查控件、取得失败反馈并选择人工暂停；具体覆盖和未完成项见 [实测报告](../reports/chrome-gap-repair-0.1.6.md)。它是受约束的工具调用 Agent 原型；成熟度和跨网站覆盖仍需后续里程碑验证。
