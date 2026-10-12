import { ChromeFormEnvironment, bindFormDocument } from "./real-tab.js";
import { isScannableUrl, isAuthenticationUrl } from "./page-scan.js";
import { createPlanContext, buildFillPlan } from "../../src/core/fill-plan.js";
import { ledgerFromProfile, PRIVATE_PROFILE_KEY, profileSummary } from "../../src/core/profile-import.js";
import { createProfileStore, isProfileEditorSender } from "./profile-store.js";
import { toolRequestSchema } from "../../src/runtime/protocol.mjs";
import { labProfile } from "../../src/fixtures/lab-profile.mjs";
import { startupStage, openAgentSocket } from "./startup-stage.js";
import { toolFailureDiagnostic } from "../../src/core/observation-diagnostics.js";

const SERVICE = "ws://127.0.0.1:4175/agent";
const tasks = new Map();
const PREFIX = "labTabTask:";
const IDLE = { status: "idle", events: [], result: null, error: null };
const popupUrl = chrome.runtime.getURL("popup.html");
const busy = () => [...tasks.values()].some((task) => !task.stopped && ["starting", "running", "waiting_review"].includes(task.state.status));
const profiles = createProfileStore({ storage: chrome.storage.local,
  isBusy: () => [...tasks.values()].some((task) => !task.stopped && ["starting", "running"].includes(task.state.status)) });
chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
let persistence = Promise.resolve();
function publish(task, update) {
  if (tasks.get(task.selection.tabId) !== task) return;
  task.state = { ...task.state, ...update };
  const state = structuredClone({ selection: task.selection, state: task.state });
  persistence = persistence.then(() => chrome.storage.session.set({ [PREFIX + task.selection.tabId]: state })).catch(() => {});
}
function record(task, event) {
  const step = (task.state.events.at(-1)?.step || 0) + 1;
  publish(task, { events: [...task.state.events, { ...event, ...(event.step ? { agentStep: event.step } : {}), step }].slice(-800) });
}
function startupRecord(task, code, summary) {
  record(task, { phase: "启动", tool: "connection", code, summary });
}
const ready = chrome.storage.session.get(null).then((stored) => {
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PREFIX) || !Number.isInteger(value.selection?.tabId)) continue;
    const state = value.state || IDLE;
    tasks.set(value.selection.tabId, { selection: value.selection, state: ["starting", "running", "waiting_review"].includes(state.status)
      ? { ...state, status: "failed", error: "AGENT_CONNECTION_INTERRUPTED：后台已中断，请检查页面后重新开始；不会重放旧动作" } : state });
  }
});
const codeOf = (error) => /^[A-Z][A-Z0-9_]{1,90}$/.test(error?.code || error?.message || "") ? error.code || error.message : "CHROME_AGENT_FAILED";
const error = (code) => Object.assign(new Error(code), { code });
async function selected(selection) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== selection?.tabId || tab.url !== selection?.url) throw error("START_TAB_CHANGED");
  if (!isScannableUrl(selection.url) || isAuthenticationUrl(selection.url)) throw error("FORM_PAGE_REQUIRED");
  return tab;
}
async function finishTask(task) {
  if (task.closing) return; task.closing = true;
  task.startupController?.abort();
  if (task.heartbeat) clearInterval(task.heartbeat);
  clearTimeout(task.acceptTimer);
  try { await task.tools; } catch { /* The error is already a structured tool response. */ }
  await task.environment?.clear().catch(() => {});
  const socket = task.socket; task.socket = null;
  try { socket?.close(); } catch { /* Already disconnected. */ }
}
function stop(task, code = "USER_STOPPED") {
  if (!task) return;
  task.stopped = true;
  task.startupController?.abort();
  if (task.socket?.readyState === WebSocket.OPEN) task.socket.send(JSON.stringify({ type: "stop", runId: task.runId }));
  publish(task, { status: code === "USER_STOPPED" ? "stopped" : "failed", error: code });
  void finishTask(task);
}
async function handleTool(task, raw) {
  if (task.stopped || task.closing) throw error("USER_STOPPED");
  task.toolStage = "request_validation";
  const { method, args } = toolRequestSchema.parse({ method: raw.method, args: raw.args });
  const env = task.environment;
  task.toolStage = "document_identity";
  await env.assertPage();
  if (method === "observe") {
    // A human may update the ledger while the graph is interrupted. Only the
    // opaque revision, never a hash of private values, reaches graph state.
    task.toolStage = "profile_reload";
    const saved = (await chrome.storage.local.get(PRIVATE_PROFILE_KEY))[PRIVATE_PROFILE_KEY];
    const profileChanged = saved?.revision !== task.ledger.profileRevision;
    if (profileChanged) task.ledger = ledgerFromProfile(saved);
    task.toolStage = "page_scan";
    const report = await env.observe();
    task.toolStage = "context_build";
    task.context = await createPlanContext(report, task.ledger, { fillMode: task.fillMode, verifiedMappings: profileChanged ? [] : args.verifiedMappings });
    return task.context;
  }
  if (method === "fill" || method === "add") {
    task.toolStage = "plan_validation";
    if (!task.context) throw error("PLAN_REQUIRED");
    const plan = await buildFillPlan(task.context, args.proposal);
    if (method === "fill") {
      const item = plan.items.find((item) => item.fieldId === args.item.fieldId && item.sourcePath === args.item.sourcePath
        && ["mapped", "needs_control_adapter", "needs_review"].includes(item.status));
      if (!item || !task.ledger.hasPath(item.sourcePath)) throw error("UNVALIDATED_FILL_TARGET");
      task.toolStage = "tool_execution";
      return args.retry ? env.retryFill(item, task.ledger) : env.fill(item, task.ledger);
    }
    if (!plan.sections.some((group) => group.groupId === args.groupId && group.additionalEntries > 0)) throw error("UNVALIDATED_ADD_TARGET");
    task.toolStage = "tool_execution";
    return env.add(args.groupId);
  }
  task.toolStage = "tool_execution";
  if (method === "audit") return env.audit(args.targets);
  if (method === "inspect") {
    if (!task.context?.page.fields.some((field) => field.id === args.fieldId)) throw error("UNVALIDATED_INSPECT_TARGET");
    return env.inspect(args.fieldId);
  }
  if (method === "wait") {
    await new Promise((resolve) => setTimeout(resolve, args.milliseconds));
    if (task.stopped) throw error("USER_STOPPED");
    await env.assertPage(); return { code: "WAIT_FINISHED" };
  }
  throw error("AGENT_TOOL_NOT_ALLOWED");
}
async function connectTask(task) {
  try {
    const signal = task.startupController.signal;
    const stages = { CHECK_TAB: "正在核对原标签页", BIND_DOCUMENT: "正在绑定原页面文档", VERIFY_DOCUMENT: "正在复核页面文档身份",
      DOCUMENT_STILL_LOADING: "网页仍处于加载状态；直接观察已出现的表单，每次操作前重新核验文档与结构" };
    task.documentId = await startupStage(() => bindFormDocument(task.selection, {
      onStage: (code) => { if (!signal.aborted) startupRecord(task, code, stages[code]); },
    }), { signal, timeoutMs: 10_000, timeoutCode: "REAL_DOCUMENT_BIND_TIMEOUT" });
    if (task.stopped) throw error("USER_STOPPED");
    startupRecord(task, "DOCUMENT_BOUND", "原页面文档已绑定，正在连接本地 Agent 服务");
    task.environment = new ChromeFormEnvironment(task.selection, { documentId: task.documentId,
      monthStartDay: task.monthStartDay, fillMode: task.fillMode });
    const socket = new WebSocket(SERVICE); task.socket = socket; task.tools = Promise.resolve();
    await openAgentSocket(socket, { signal, timeoutMs: 5000 });
    if (task.stopped) throw error("USER_STOPPED");
    startupRecord(task, "SERVICE_CONNECTED", "本地服务连接成功，正在发送任务");
    socket.onmessage = (event) => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "pong") return;
      if (message.runId !== task.runId || task.stopped) return;
      if (!task.accepted) {
        task.accepted = true; clearTimeout(task.acceptTimer);
        publish(task, { status: "running" });
        startupRecord(task, "AGENT_ACCEPTED_TASK", "Agent 已收到任务，开始观察原标签页");
      }
      if (message.type === "tool") {
        task.tools = task.tools.then(async () => {
          let response;
          try { response = { ok: true, result: await handleTool(task, message) }; }
          catch (err) {
            const diagnostic = toolFailureDiagnostic(err, message.method, task.toolStage);
            const code = codeOf(err);
            response = { ok: false, code, toolDiagnostic: diagnostic };
            record(task, { phase: "失败", tool: diagnostic.method, code,
              summary: `${diagnostic.method} 执行失败；阶段 ${diagnostic.stage}；异常类型 ${diagnostic.errorType}；校验位置可展开查看`,
              toolDiagnostic: diagnostic });
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "tool_result", id: message.id, runId: task.runId, ...response }));
        }); return;
      }
      if (message.type === "event") {
        record(task, message.event); return;
      }
      if (message.type === "result") {
        publish(task, { status: message.status, result: message.result, outcomes: message.outcomes || [], review: message.review || null,
          error: message.status === "failed" ? message.result?.code || "AGENT_RUNTIME_FAILED" : null });
        if (message.status !== "waiting_review") void finishTask(task);
        return;
      }
      if (message.type === "error") {
        publish(task, { status: message.code === "USER_STOPPED" ? "stopped" : "failed", error: codeOf({ code: message.code }) });
        void finishTask(task);
      }
    };
    socket.onclose = () => {
      if (!task.closing && !task.stopped) { publish(task, { status: "failed", error: "AGENT_CONNECTION_INTERRUPTED：本轮停止，已填写内容保留" }); void finishTask(task); }
    };
    socket.onerror = () => { if (!task.closing) { publish(task, { status: "failed", error: "LOCAL_SERVICE_UNAVAILABLE" }); void finishTask(task); } };
    task.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" })); }, 20_000);
    task.acceptTimer = setTimeout(() => stop(task, "AGENT_START_ACK_TIMEOUT"), 10_000);
    socket.send(JSON.stringify({ type: "start", runId: task.runId }));
    startupRecord(task, "AGENT_START_SENT", "任务已发送，等待 Agent 的首次响应");
  } catch (err) {
    const code = task.stopped ? task.state.error || "USER_STOPPED" : codeOf(err);
    startupRecord(task, code, `启动停止：${code}；本次未进入表单执行`);
    publish(task, { status: task.stopped && code === "USER_STOPPED" ? "stopped" : "failed", error: code });
    await finishTask(task);
  }
}
async function loadLedger() {
  const stored = (await chrome.storage.local.get(PRIVATE_PROFILE_KEY))[PRIVATE_PROFILE_KEY];
  return stored ? { ledger: ledgerFromProfile(stored), importedAt: stored.importedAt } : null;
}
async function handleMessage(message, sender) {
  await ready;
  if (message?.type === "page-delay") {
    const task = tasks.get(sender.tab?.id);
    if (!task || sender.id !== chrome.runtime.id || sender.frameId !== 0 || task.documentId !== sender.documentId
      || sender.url !== task.selection.url || task.stopped || task.state.status !== "running"
      || !Number.isInteger(message.ms) || message.ms < 1 || message.ms > 1000) throw error("PAGE_WAIT_DENIED");
    await new Promise((resolve) => setTimeout(resolve, message.ms));
    if (task.stopped) throw error("USER_STOPPED");
    return { waited: true };
  }
  if (["profile-editor-load", "profile-editor-save"].includes(message?.type)) {
    if (!isProfileEditorSender(sender, chrome.runtime)) throw error("PROFILE_EDITOR_ACCESS_DENIED");
    if (message.type === "profile-editor-save") return profiles.save(message);
    return { ...await profiles.read(), configurationRequests: (await chrome.storage.session.get("labConfigurationRequest")).labConfigurationRequest || [] };
  }
  if (sender.id !== chrome.runtime.id || sender.url !== popupUrl) throw error("EXTENSION_MESSAGE_DENIED");
  if (message.type === "profile-status") {
    const profile = await loadLedger(); return profile ? profileSummary(profile.ledger, profile.importedAt) : { available: false };
  }
  if (message.type === "profile-import") return profiles.import(message.data);
  if (message.type === "demo-profile") {
    await selected(message.selection);
    const url = new URL(message.selection.url);
    if (url.origin !== "http://127.0.0.1:4175" || url.pathname !== "/practice") throw error("SYNTHETIC_PROFILE_LOCAL_ONLY");
    return profiles.import(labProfile);
  }
  const task = tasks.get(message.selection?.tabId);
  const same = task?.selection.url === message.selection?.url ? task : null;
  if (message.type === "status") return same?.state || IDLE;
  if (message.type === "configure-gaps") {
    const coverage = same?.state.result?.fieldCoverage || [];
    if (!coverage.length) throw error("COVERAGE_NOT_AVAILABLE");
    const requests = coverage.filter((field) => !["filled_verified", "existing_value_unverified", "manual_only"].includes(field.status));
    await chrome.storage.session.set({ labConfigurationRequest: requests });
    await chrome.tabs.create({ url: chrome.runtime.getURL("profile-editor.html#customAnswers") });
    return { count: requests.length };
  }
  if (message.type === "stop") { stop(same); return { stopped: true }; }
  if (message.type === "resume") {
    if (same?.state.status !== "waiting_review" || same.socket?.readyState !== WebSocket.OPEN) throw error("AGENT_NOT_PAUSED");
    publish(same, { status: "running", review: null }); same.socket.send(JSON.stringify({ type: "resume", runId: same.runId })); return same.state;
  }
  if (message.type !== "start") throw error("UNKNOWN_MESSAGE");
  await selected(message.selection);
  if (same && !same.stopped && ["starting", "running", "waiting_review"].includes(same.state.status) || profiles.isWriting) throw error("AGENT_ALREADY_RUNNING");
  const stored = await loadLedger(); if (!stored) throw error("PROFILE_REQUIRED");
  if (stored.ledger.profileKind === "synthetic" && !["127.0.0.1", "localhost"].includes(new URL(message.selection.url).hostname)) throw error("SYNTHETIC_PROFILE_LOCAL_ONLY");
  const taskNow = { selection: message.selection, runId: crypto.randomUUID(), ledger: stored.ledger,
    fillMode: message.fillMode === "empty" ? "empty" : "overwrite", monthStartDay: message.monthStartDay === true,
    state: { ...IDLE, status: "starting", runId: null, origin: new URL(message.selection.url).origin },
    socket: null, tools: Promise.resolve(), stopped: false, startupController: new AbortController() };
  taskNow.state.runId = taskNow.runId;
  tasks.set(message.selection.tabId, taskNow); publish(taskNow, {});
  startupRecord(taskNow, "START_REQUESTED", "已接收开始指令；资料已载入，正在准备原标签页");
  void connectTask(taskNow); return taskNow.state;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handleMessage(message, sender).then((value) => respond({ ok: true, value }), (err) => respond({ ok: false, error: codeOf(err) })); return true;
});
chrome.tabs.onUpdated.addListener((tabId, change) => { const task = tasks.get(tabId);
  if (task && (change.status === "loading" || change.url && change.url !== task.selection.url)) stop(task, "REAL_PAGE_CHANGED"); });
chrome.tabs.onRemoved.addListener((tabId) => { const task = tasks.get(tabId); stop(task, "REAL_PAGE_CHANGED"); tasks.delete(tabId);
  persistence = persistence.then(() => chrome.storage.session.remove(PREFIX + tabId)).catch(() => {}); });
