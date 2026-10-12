let selection, current = { events: [] }, active = false;
const $ = (id) => document.getElementById(id);
async function message(type, args = {}) {
  const response = await chrome.runtime.sendMessage({ type, selection, ...args });
  if (!response?.ok) throw new Error(response?.error || "EXTENSION_MESSAGE_FAILED"); return response.value;
}
async function action(work) { $("error").textContent = ""; try { await work(); await refresh(); } catch (error) { $("error").textContent = error.message; } }
const labels = { idle: "等待开始", starting: "正在连接原标签页与 Agent 服务", running: "Agent 正在决定与执行", waiting_review: "Agent 已暂停，等待你核对", partial: "本轮结束，仍需人工核对", needs_review: "需要人工处理", stopped: "已停止", failed: "本轮失败" };
async function refresh() {
  if (!selection) return;
  current = await message("status");
  active = ["starting", "running", "waiting_review"].includes(current.status);
  $("status").textContent = labels[current.status] || current.status;
  $("start").disabled = active; $("stop").hidden = !active; $("resume").hidden = current.status !== "waiting_review";
  $("edit").disabled = ["starting", "running"].includes(current.status); $("import").disabled = active; $("demo").disabled = active;
  $("error").textContent = current.error || "";
  const r = current.result;
  $("metrics").textContent = r ? `核验写入 ${r.agentWrittenFields} 项 · 添加 ${r.agentAddedCards} 组 · 模型决策 ${r.decisionCalls} 次 · 可见空白 ${r.remainingBlankFields} 项 · 未规划 ${r.unplannedCount} 项。服务器是否接收：未验证。` : "";
  const coverage = r?.fieldCoverage?.filter((field) => !["filled_verified", "existing_value_unverified", "manual_only"].includes(field.status)) || [];
  $("coverage-panel").hidden = !coverage.length;
  $("configure-gaps").disabled = ["starting", "running"].includes(current.status);
  $("coverage").replaceChildren();
  const cause = { missing_profile: "缺少独立答案", configured_unmapped: "资料存在，尚未核验写入", not_planned: "尚未规划，资料来源待核对", needs_date_confirmation: "日期缺少具体日，需要确认",
    page_initialization_incomplete: "资料存在，网页控件尚未初始化", dictionary_unavailable: "资料存在，网页地区数据未加载",
    unsupported_control: "控件尚未处理成功", execution_failed: "资料存在，执行失败", needs_review: "来源待核对" };
  for (const field of coverage) { const li = document.createElement("li"); li.textContent = [field.questionContext, field.label].filter(Boolean).join(" / ")
    .replace(/[\s:：]+$/g, "")
    + "：" + (cause[field.status] || field.status) + (field.code ? " · " + field.code : ""); $("coverage").append(li); }
  const events = $("events"); events.replaceChildren();
  for (const event of (current.events || []).slice(-60)) {
    const li = document.createElement("li"), text = document.createElement("div"), code = document.createElement("div");
    text.textContent = `${event.step}. ${event.phase} / ${event.tool}：${event.summary || event.nextGoal || ""}`;
    code.textContent = event.code || ""; code.className = "code"; li.append(text, code); events.append(li);
    if (event.diagnostic || event.responseDiagnostic || event.inspection || event.toolDiagnostic) {
      const detail = document.createElement("details"), title = document.createElement("summary"), data = document.createElement("pre");
      title.textContent = "查看校验依据";
      detail.open = event.tool === "plan_fields";
      data.textContent = JSON.stringify({ ...(event.diagnostic ? { validation: event.diagnostic } : {}),
        ...(event.responseDiagnostic ? { response: event.responseDiagnostic } : {}), ...(event.inspection ? { inspection: event.inspection } : {}),
        ...(event.toolDiagnostic ? { toolFailure: event.toolDiagnostic } : {}) }, null, 2);
      detail.append(title, data); li.append(detail);
    }
  }
}
$("start").onclick = () => action(() => message("start", { fillMode: $("mode").value, monthStartDay: $("day").checked }));
$("stop").onclick = () => action(() => message("stop"));
$("resume").onclick = () => action(() => message("resume"));
$("edit").onclick = () => chrome.runtime.openOptionsPage();
$("configure-gaps").onclick = () => action(() => message("configure-gaps"));
$("setup").onclick = () => chrome.tabs.create({ url: "http://127.0.0.1:4175/" });
$("import").onclick = () => $("file").click();
$("file").onchange = () => action(async () => {
  const file = $("file").files[0]; if (!file) return;
  if (file.size > 2_000_000) throw new Error("PROFILE_IMPORT_TOO_LARGE");
  await message("profile-import", { data: JSON.parse(await file.text()) }); $("file").value = ""; await profile();
});
$("demo").onclick = () => action(async () => { await message("demo-profile"); await profile(); });
$("copy").onclick = () => action(async () => {
  const data = { version: chrome.runtime.getManifest().version, agentRuntime: "langgraph_model_directed", submissionPolicy: "agent_actions_only",
    origin: current.origin, status: current.status, result: current.result, error: current.error, events: current.events, outcomes: current.outcomes };
  await navigator.clipboard.writeText(JSON.stringify(data, null, 2)); $("status").textContent = "本次记录已复制";
});
async function profile() { const p = await message("profile-status"); $("profile").textContent = p.available ? `资料可用，共 ${p.factCount} 个资料路径` : "此实验扩展从空资料库开始；请编辑或导入备份"; }
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  selection = { tabId: tab.id, url: tab.url }; $("page").textContent = tab.url ? new URL(tab.url).origin : "未选择网页";
  $("demo").hidden = tab.url !== "http://127.0.0.1:4175/practice";
  await profile(); await refresh(); setInterval(() => refresh().catch(() => {}), 1000);
}
void init().catch((error) => { $("error").textContent = error.message; $("start").disabled = true; });
