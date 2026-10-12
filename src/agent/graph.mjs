import { StateGraph, StateSchema, MemorySaver, START, END, interrupt, Command } from "@langchain/langgraph";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { validatePlanContext, buildFillPlan, validatePlanFailureFeedback } from "../core/fill-plan.js";
import { decisionSchema, decisionDiagnosticSchema } from "./tools.mjs";
import { authorize, candidates, modelContext, safeCode, safeOutcome, topology, fieldKey, targetKey } from "./policy.mjs";
import { fieldCoverage } from "../core/field-coverage.js";
import { controlInspectionSchema } from "../core/control-inspection.js";

const State = new StateSchema({
  context: z.unknown().nullable().default(null), proposal: z.unknown().nullable().default(null),
  plan: z.unknown().nullable().default(null), decision: z.unknown().nullable().default(null),
  authorization: z.unknown().nullable().default(null), planFailure: z.unknown().nullable().default(null),
  lastResult: z.unknown().nullable().default(null), history: z.array(z.unknown()).default([]),
  receipts: z.array(z.unknown()).default([]), attempts: z.record(z.string(), z.number()).default({}),
  inspections: z.record(z.string(), z.unknown()).default({}),
  failedAdds: z.array(z.string()).default([]), steps: z.number().default(0), writes: z.number().default(0),
  added: z.number().default(0), mappingCalls: z.number().default(0), decisionFailures: z.number().default(0),
  mutationEpoch: z.number().default(0), auditEpoch: z.number().default(-1),
  stopCode: z.string().nullable().default(null), result: z.unknown().nullable().default(null),
  reviewIntent: z.object({ reason: z.enum(["missing_data", "ambiguous_mapping", "unsupported_control", "repeated_failure", "user_check"]),
    requestedAtStep: z.number().int().min(0) }).nullable().default(null),
  limits: z.object({ maxSteps: z.number().int().min(1).max(500), maxWrites: z.number().int().min(1).max(300),
    maxAdds: z.number().int().min(0).max(30) }).default({ maxSteps: 120, maxWrites: 200, maxAdds: 20 }),
});

const verificationCounts = (receipts) => ({
  inputStateVerified: receipts.filter((r) => r.verified && r.diagnostic?.pageStateMatched === true).length,
  controlReadbackOnly: receipts.filter((r) => r.verified && r.diagnostic?.pageStateMatched !== true).length,
  inputStateMismatch: receipts.filter((r) => r.diagnostic?.pageStateObserved === true && r.diagnostic?.pageStateMatched === false).length,
});
export function summarize(state) {
  const available = candidates(state);
  const verified = state.receipts.filter((r) => r.verified).length;
  const coverage = fieldCoverage(state.context, state.plan, state.receipts);
  return {
    agentRuntime: "langgraph_model_directed", submissionPolicy: "agent_actions_only", serverAcceptance: "not_checked",
    code: state.stopCode || "NEEDS_HUMAN_REVIEW", agentWrittenFields: verified, agentAddedCards: state.added,
    logicalModelCalls: state.steps + state.mappingCalls, decisionCalls: state.steps, mappingCalls: state.mappingCalls,
    expectedFields: coverage.filter((field) => field.configured && field.status !== "manual_only").length,
    writeAttempts: state.writes, observedFields: state.context?.page.fields.length || 0,
    remainingBlankFields: state.context?.page.fields.filter((f) => f.hasValue === false && !f.disabled
      && !["checkbox", "credential", "file", "signature"].includes(f.kind)).length || 0,
    remainingMappedFields: available.pending.length + available.retryable.length,
    unresolvedCount: state.receipts.filter((r) => !r.verified && r.code !== "PROTECTED").length,
    planAvailable: !!state.plan,
    unplannedCount: state.plan ? state.plan.items.filter((r) => ["missing_profile", "ambiguous_mapping", "unmapped", "label_missing", "source_conflict", "source_unverified"].includes(r.status)).length
      : state.context?.page.fields.filter((f) => !f.disabled && !f.knownSourcePath && !["checkbox", "credential", "file", "signature"].includes(f.kind)
        && !(f.readOnly && ["text", "textarea", "number"].includes(f.kind))).length || 0,
    pendingEntries: (state.plan?.summary.additionalEntries || 0) + (state.plan?.summary.unresolvedEntries || 0),
    auditCurrent: state.auditEpoch === state.mutationEpoch,
    verificationCounts: verificationCounts(state.receipts), fillMode: state.context?.fillMode || "overwrite",
    fieldCoverage: coverage,
  };
}

/** Model-directed actions run on a genuine LangGraph cycle. Browser/profile objects never enter graph state. */
export function createResumeAgent({ model, planner, environment, onEvent = () => {}, signal, checkpointer = new MemorySaver(),
  threadId = randomUUID(), limits = {} }) {
  let eventStep = 0;
  const emit = (phase, tool, code, extra = {}) => onEvent({ step: ++eventStep, phase, tool, code, ...extra });
  const stopped = () => signal?.aborted;
  const receiptTargets = (state) => state.receipts.filter((r) => r.verified).map(({ fieldId, sourcePath }) => ({ fieldId, sourcePath }));
  const remember = (state, result) => [...state.history, { step: state.steps, tool: state.decision?.action?.tool || "model",
    code: result.code, ...(result.fieldId ? { fieldId: result.fieldId, sourcePath: result.sourcePath } : {}),
    resultKey: createHash("sha256").update(JSON.stringify([result.code, result.diagnostic || null, result.responseDiagnostic || null])).digest("hex"),
    ...(result.verified !== undefined ? { verified: result.verified } : {}) }].slice(-64);
  const observe = async (state) => {
    if (stopped()) return { stopCode: "USER_STOPPED" };
    const context = await validatePlanContext(await environment.observe({ verifiedMappings: receiptTargets(state) }));
    let proposal = state.proposal, plan = null, planFailure = state.planFailure, auditEpoch = state.auditEpoch;
    let receipts = state.receipts.map((receipt) => {
      const matches = context.page.fields.filter((field) => fieldKey(context, field.id) + "|" + receipt.sourcePath === receipt.key);
      if (matches.length !== 1 || matches[0].hasValue === false) {
        if (receipt.verified) {
          auditEpoch = -1;
          return { ...receipt, verified: false, code: matches.length === 1 ? "WRITE_LOST_ON_OBSERVATION" : "WRITE_TARGET_RETIRED" };
        }
        // An empty field following a failed attempt is not a lost successful
        // write. Preserve its precise execution failure for the next decision.
        return matches.length === 1 ? { ...receipt, fieldId: matches[0].id } : receipt;
      }
      return { ...receipt, fieldId: matches[0].id };
    });
    const profileChanged = state.context && context.profileRevision !== state.context.profileRevision;
    const structureChanged = state.context && topology(context) !== topology(state.context);
    if (profileChanged) {
      proposal = null; planFailure = null; auditEpoch = -1; receipts = [];
      emit("观察", "profile", "PROFILE_CHANGED", { summary: "资料已更新，旧来源计划和核验结果作废；保留网页内容，重新交给模型决策" });
    } else if (structureChanged) {
      proposal = null; planFailure = null; auditEpoch = -1;
      emit("观察", "observe", "STRUCTURE_CHANGED", { summary: "页面结构改变，旧映射已作废；模型将重新选择动作" });
    } else if (proposal) {
      try { proposal = { ...proposal, snapshotId: context.snapshotId }; plan = await buildFillPlan(context, proposal); }
      catch { proposal = null; }
    }
    emit("观察", "observe", "OBSERVED", { summary: `读取 ${context.page.fields.length} 个字段、${context.page.groups.length} 个分组`,
      counts: { fields: context.page.fields.length, groups: context.page.groups.length } });
    return { context, proposal, plan, receipts, planFailure, auditEpoch,
      ...(profileChanged ? { attempts: {}, inspections: {}, failedAdds: [], reviewIntent: null } : structureChanged ? { inspections: {} } : {}) };
  };
  const decide = async (state) => {
    if (stopped()) return { stopCode: "USER_STOPPED" };
    if (state.steps >= state.limits.maxSteps) return { stopCode: "STEP_BUDGET_EXHAUSTED" };
    emit("决策", "model", "DECISION_STARTED", { summary: "模型正在根据当前页面、上次结果和剩余预算选择下一项工具" });
    let decision;
    try { decision = decisionSchema.parse(await model.decide(modelContext(state), { signal })); }
    catch (error) {
      const code = safeCode(error?.code, "AGENT_DECISION_INVALID");
      const diagnostic = decisionDiagnosticSchema.safeParse(error?.decisionDiagnostic);
      const lastResult = { code, ...(diagnostic.success ? { decisionDiagnostic: diagnostic.data } : {}) };
      emit("核验", "model", code, { summary: "模型调用或结构化动作未通过；没有代替模型执行填写",
        ...(diagnostic.success ? { decisionDiagnostic: diagnostic.data } : {}),
        ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}) });
      return { steps: state.steps + 1, decision: null, lastResult, decisionFailures: state.decisionFailures + 1,
        stopCode: state.decisionFailures >= 2 || code === "USER_STOPPED" ? code : null,
        history: remember(state, { code }) };
    }
    const deferred = decision.deferredActions.length;
    emit("决策", decision.action.tool, "MODEL_SELECTED_TOOL", { evaluation: decision.evaluation, nextGoal: decision.nextGoal,
      summary: decision.nextGoal + (deferred ? `；本次模型共提出 ${deferred + 1} 项动作，执行第一项，其余 ${deferred} 项等待重新观察` : ""),
      counts: { modelActionsDeclared: deferred + 1, actionsDeferred: deferred },
      ...(decision.action.fieldId ? { fieldId: decision.action.fieldId, sourcePath: decision.action.sourcePath } : {}),
      ...(decision.action.groupId ? { groupId: decision.action.groupId } : {}) });
    return { decision, steps: state.steps + 1, decisionFailures: 0 };
  };
  const policy = async (state) => {
    if (stopped()) return { stopCode: "USER_STOPPED" };
    const authorization = authorize(state, state.decision.action);
    const repeated = state.history.slice(-3).every((h) => h.tool === state.decision.action.tool
      && h.fieldId === state.decision.action.fieldId && h.sourcePath === state.decision.action.sourcePath
      && h.resultKey === state.history.at(-1)?.resultKey);
    if (state.history.length >= 3 && repeated) return { stopCode: "REPEATED_ACTION_LIMIT", authorization: { allowed: false } };
    if (!authorization.allowed) {
      const lastResult = { code: authorization.code };
      emit("核验", "policy", authorization.code, { summary: `动作未获准执行：${authorization.code}` });
      return { authorization, lastResult, history: remember(state, lastResult),
        ...(state.decision.action.tool === "request_review" && authorization.code === "FINAL_AUDIT_REQUIRED"
          ? { reviewIntent: { reason: state.decision.action.reason, requestedAtStep: state.steps } } : {}) };
    }
    return { authorization };
  };
  const execute = async (state) => {
    const action = state.decision.action;
    if (stopped()) return { stopCode: "USER_STOPPED" };
    // A model call can take minutes. Always compare a fresh observation before an action, including finish.
    const fresh = await validatePlanContext(await environment.observe({ verifiedMappings: receiptTargets(state) }));
    if (fresh.snapshotId !== state.context.snapshotId) {
      const lastResult = { code: "STALE_OBSERVATION" };
      emit("核验", "preflight", lastResult.code, { summary: "模型等待期间页面发生变化，旧动作已取消，重新观察" });
      return { lastResult, history: remember(state, lastResult) };
    }
    let update = {}, lastResult;
    emit("执行", action.tool, "TOOL_STARTED", { summary: `执行模型选择的 ${action.tool}` });
    try {
      if (action.tool === "plan_fields") {
        update.mappingCalls = state.mappingCalls + 1;
        let feedback;
        try { if (state.planFailure) feedback = validatePlanFailureFeedback(state.context, state.planFailure); } catch { /* Old references are never reused. */ }
        const proposal = await planner.planMappings(state.context, feedback, { onProgress: (progress) => {
          emit("规划", "plan_fields", progress.phase === "started" ? "PLAN_REGION_STARTED" : "PLAN_REGION_COMPLETED", {
            groupId: progress.groupId, summary: `分组规划 ${progress.completedRegions}/${progress.totalRegions}；${progress.phase === "started" ? "正在请求模型" : "已收到映射建议"}`,
          });
        } });
        const plan = await buildFillPlan(state.context, proposal);
        update = { ...update, proposal, plan, planFailure: null };
        const available = candidates({ ...state, plan });
        lastResult = { code: "PLAN_VALIDATED", mapped: plan.items.filter((item) => item.sourcePath).length,
          pendingCount: available.pending.length, retryableCount: available.retryable.length,
          missingDataCount: fieldCoverage(state.context, plan, state.receipts).filter((field) => field.status === "missing_profile").length };
      } else if (action.tool === "inspect_field") {
        const inspection = controlInspectionSchema.parse(await environment.inspect(action.fieldId));
        if (inspection.fieldId !== action.fieldId) throw Object.assign(new Error("AGENT_INSPECTION_INVALID"), { code: "AGENT_INSPECTION_INVALID" });
        update.inspections = { ...state.inspections, [fieldKey(state.context, action.fieldId)]: inspection };
        lastResult = inspection;
      } else if (["fill_field", "retry_field"].includes(action.tool)) {
        const item = state.authorization.item;
        const outcome = safeOutcome(await environment.fill(item, { retry: action.tool === "retry_field", proposal: state.proposal }));
        const key = targetKey(state.context, item);
        const receipt = { key, fieldId: item.fieldId, sourcePath: item.sourcePath, ...outcome };
        update = { receipts: [...state.receipts.filter((r) => r.key !== key), receipt],
          attempts: { ...state.attempts, [key]: (state.attempts[key] || 0) + 1 }, writes: state.writes + 1,
          mutationEpoch: state.mutationEpoch + 1 };
        lastResult = { ...outcome, fieldId: item.fieldId, sourcePath: item.sourcePath };
      } else if (action.tool === "add_entry") {
        const outcome = safeOutcome(await environment.add(action.groupId, { proposal: state.proposal }));
        update = { added: state.added + (outcome.verified ? 1 : 0), mutationEpoch: state.mutationEpoch + 1,
          failedAdds: outcome.verified ? state.failedAdds : [...state.failedAdds, action.groupId] };
        lastResult = { ...outcome, groupId: action.groupId };
      } else if (action.tool === "audit") {
        const targets = state.receipts.filter((r) => state.context.page.fields.some((f) => f.id === r.fieldId));
        const checked = await environment.audit(targets.map(({ fieldId, sourcePath }) => ({ fieldId, sourcePath })));
        if (!Array.isArray(checked) || checked.length !== targets.length || targets.some((target) =>
          checked.filter((r) => r.fieldId === target.fieldId && r.sourcePath === target.sourcePath).length !== 1))
          throw Object.assign(new Error("AGENT_AUDIT_INVALID"), { code: "AGENT_AUDIT_INVALID" });
        update = { receipts: state.receipts.map((receipt) => {
          const result = checked.find((r) => r.fieldId === receipt.fieldId && r.sourcePath === receipt.sourcePath);
          // An audit must not erase the original execution failure simply
          // because that attempt never created a write receipt.
          return result ? !receipt.verified && !result.verified
            ? { ...receipt, auditCode: safeCode(result.code) } : { ...receipt, ...safeOutcome(result) } : receipt;
        }), auditEpoch: state.mutationEpoch };
        lastResult = { code: "AUDIT_FINISHED", verifiedCount: update.receipts.filter((r) => r.verified).length };
      } else if (action.tool === "wait") {
        await environment.wait(action.milliseconds, { signal }); lastResult = { code: "WAIT_FINISHED" };
      } else if (action.tool === "finish") {
        update.stopCode = "MODEL_FINISHED"; lastResult = { code: "MODEL_FINISHED" };
      }
    } catch (error) {
      const code = safeCode(error?.code);
      lastResult = { code, verified: false };
      if (action.tool === "plan_fields") {
        try {
          const failure = validatePlanFailureFeedback(state.context, { code,
            ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
            ...(error.responseDiagnostic ? { responseDiagnostic: error.responseDiagnostic } : {}),
          });
          const previousFailures = state.planFailure ? [...(state.planFailure.previousFailures || []),
            Object.fromEntries(Object.entries(state.planFailure).filter(([key]) => key !== "previousFailures"))].slice(-24) : [];
          update.planFailure = validatePlanFailureFeedback(state.context, { ...failure, ...(previousFailures.length ? { previousFailures } : {}) });
          lastResult = { ...lastResult, ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
            ...(failure.responseDiagnostic ? { responseDiagnostic: failure.responseDiagnostic } : {}) };
        }
        catch { update.planFailure = null; }
        update.proposal = null; update.plan = null;
      }
      if (["fill_field", "retry_field"].includes(action.tool)) {
        const item = state.authorization.item, key = targetKey(state.context, item);
        update = { attempts: { ...state.attempts, [key]: (state.attempts[key] || 0) + 1 }, writes: state.writes + 1,
          mutationEpoch: state.mutationEpoch + 1,
          receipts: [...state.receipts.filter((r) => r.key !== key), { key, fieldId: item.fieldId, sourcePath: item.sourcePath, code, verified: false }] };
      }
      if (action.tool === "add_entry") update.failedAdds = [...state.failedAdds, action.groupId];
      if (["REAL_PAGE_CHANGED", "REAL_DOCUMENT_UNVERIFIED", "USER_STOPPED"].includes(code)) update.stopCode = code;
    }
    if (state.decision.deferredActions.length) lastResult.deferredActionCount = state.decision.deferredActions.length;
    emit("反馈", action.tool, lastResult.code, { summary: `${action.tool} 返回 ${lastResult.code}，交给下一轮模型决策`,
      ...(lastResult.fieldId ? { fieldId: lastResult.fieldId, sourcePath: lastResult.sourcePath } : {}),
      ...(lastResult.diagnostic ? { diagnostic: lastResult.diagnostic } : {}), ...(lastResult.verified !== undefined ? { verified: lastResult.verified } : {}),
      ...(lastResult.responseDiagnostic ? { responseDiagnostic: lastResult.responseDiagnostic } : {}),
      ...(action.tool === "inspect_field" ? { inspection: lastResult } : {}),
      ...(lastResult.completedDay ? { completedDay: true } : {}) });
    return { ...update, lastResult, history: remember(state, lastResult) };
  };
  const review = async (state) => {
    const response = interrupt({ code: "HUMAN_REVIEW_REQUIRED", reason: state.decision.action.reason,
      counts: summarize(state), nextGoal: state.decision.nextGoal });
    const continueRun = response === "continue";
    emit("人工", "request_review", continueRun ? "USER_RESUMED" : "USER_STOPPED", { summary: continueRun
      ? "用户选择继续；重新观察原文档，再由模型决定下一步" : "用户停止任务，保留已填写内容" });
    return { lastResult: { code: continueRun ? "USER_RESUMED" : "USER_STOPPED" }, stopCode: continueRun ? null : "USER_STOPPED", reviewIntent: null };
  };
  const finish = async (state) => {
    const result = { ...summarize(state), modelHttpRequests: Number.isInteger(model.metrics?.requests) && Number.isInteger(planner.metrics?.requests)
      ? model.metrics.requests + planner.metrics.requests : null };
    emit("完成", "review", result.code, { summary: `本轮核验 ${result.agentWrittenFields} 个字段；可见空白 ${result.remainingBlankFields} 个，`
      + `未规划 ${result.unplannedCount} 个，待添加经历 ${result.pendingEntries} 组；招聘服务器是否接收仍需人工核对`, counts: result });
    return { result };
  };
  const graph = new StateGraph(State)
    .addNode("observe", observe).addNode("decide", decide).addNode("policy", policy)
    .addNode("execute", execute).addNode("human_review", review).addNode("finish", finish)
    .addEdge(START, "observe")
    .addConditionalEdges("observe", (s) => s.stopCode ? "finish" : "decide")
    .addConditionalEdges("decide", (s) => s.stopCode ? "finish" : s.decision ? "policy" : "decide")
    .addConditionalEdges("policy", (s) => s.stopCode ? "finish" : !s.authorization.allowed ? "decide"
      : s.decision.action.tool === "request_review" ? "human_review" : "execute")
    .addConditionalEdges("execute", (s) => s.stopCode ? "finish" : "observe")
    .addConditionalEdges("human_review", (s) => s.stopCode ? "finish" : "observe")
    .addEdge("finish", END).compile({ checkpointer });
  const config = { configurable: { thread_id: threadId }, recursionLimit: 2500 };
  let invoked = false, running = false;
  const invoke = async (input) => {
    if (running) throw Object.assign(new Error("AGENT_ALREADY_RUNNING"), { code: "AGENT_ALREADY_RUNNING" });
    running = true;
    try {
      const output = await graph.invoke(input, config);
      const paused = Array.isArray(output.__interrupt__) && output.__interrupt__.length > 0;
      return { status: paused ? "waiting_review" : output.stopCode === "USER_STOPPED" ? "stopped"
        : /^(AGENT_|MODEL_|REAL_|CHROME_)/.test(output.stopCode || "") && output.stopCode !== "MODEL_FINISHED" ? "failed"
        : output.result?.agentWrittenFields > 0 ? "partial" : "needs_review",
        result: output.result || summarize(output), outcomes: output.receipts.map(({ key, ...r }) => ({ tool: "fill_field", ...r })),
        ...(paused ? { review: output.__interrupt__[0].value } : {}) };
    } finally { running = false; }
  };
  return { graph, checkpointer, threadId, config,
    async run() { if (invoked) throw new Error("AGENT_ALREADY_STARTED"); invoked = true; return invoke({ limits: { maxSteps: 120, maxWrites: 200, maxAdds: 20, ...limits } }); },
    async resume(command = "continue") {
      if (!invoked || (await graph.getState(config)).next[0] !== "human_review") throw new Error("AGENT_NOT_PAUSED");
      return invoke(new Command({ resume: command }));
    },
    async dispose() { if (typeof checkpointer.deleteThread === "function") await checkpointer.deleteThread(threadId); },
  };
}
