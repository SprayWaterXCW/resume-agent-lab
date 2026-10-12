import { createHash } from "node:crypto";
import { actionSchema } from "./tools.mjs";
import { safeControlDiagnostic } from "../core/control-diagnostics.js";
import { fieldCoverage } from "../core/field-coverage.js";

export const EXECUTABLE = new Set(["mapped", "needs_control_adapter", "needs_review"]);
export const safeCode = (value, fallback = "AGENT_TOOL_FAILED") => /^[A-Z][A-Z0-9_]{1,90}$/.test(value || "") ? value : fallback;
export const topology = (context) => createHash("sha256").update(JSON.stringify({
  groups: context.page.groups,
  fields: context.page.fields.map(({ hasValue, knownSourcePath, ...metadata }) => metadata),
  truncated: context.page.truncated,
})).digest("hex");
export function fieldKey(context, fieldId) {
  const field = context?.page.fields.find((item) => item.id === fieldId);
  const group = context?.page.groups.find((item) => item.id === field?.groupId);
  if (!field || !group || field.labelSource === "missing") return null;
  const identity = (entry) => JSON.stringify([context.page.groups.find((g) => g.id === entry.groupId)?.label,
    entry.entryIndex, entry.label, entry.kind, entry.datePart || null, entry.dateRole || null, entry.optionLabel || null, entry.questionContext || null]);
  const key = identity(field);
  return context.page.fields.filter((entry) => identity(entry) === key).length === 1 ? key : null;
}
export const targetKey = (context, item) => fieldKey(context, item.fieldId) + "|" + item.sourcePath;
export function safeOutcome(raw) {
  if (!raw || typeof raw.verified !== "boolean") return { code: "AGENT_TOOL_RESULT_INVALID", verified: false };
  const diagnostic = safeControlDiagnostic({ ...raw.diagnostic, ...(raw.optionCount !== undefined ? { optionCount: raw.optionCount } : {}) });
  return { code: safeCode(raw.code, "AGENT_TOOL_RESULT_INVALID"), verified: raw.verified,
    ...(diagnostic ? { diagnostic } : {}),
    ...(raw.completedDay === true ? { completedDay: true } : {}) };
}
export function candidates(state) {
  const items = state.plan?.items.filter((item) => item.sourcePath && EXECUTABLE.has(item.status) && fieldKey(state.context, item.fieldId)) || [];
  const pending = items.filter((item) => !state.receipts.some((receipt) => receipt.key === targetKey(state.context, item)
    && (receipt.verified || receipt.code === "PROTECTED")));
  const retryable = pending.filter((item) => (state.attempts[targetKey(state.context, item)] || 0) === 1);
  return { pending: pending.filter((item) => !state.attempts[targetKey(state.context, item)]), retryable,
    missingEntries: state.plan?.sections.filter((section) => section.additionalEntries > 0
      && state.context.page.groups.find((group) => group.id === section.groupId)?.hasAddCandidate
      && !state.failedAdds.includes(section.groupId)) || [] };
}
export function authorize(state, input) {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) return { allowed: false, code: "AGENT_TOOL_NOT_ALLOWED" };
  const action = parsed.data;
  if (!state.context || action.snapshotId !== state.context.snapshotId) return { allowed: false, code: "STALE_OBSERVATION" };
  if (["fill_field", "retry_field", "add_entry"].includes(action.tool) && !state.plan)
    return { allowed: false, code: "PLAN_REQUIRED" };
  const available = candidates(state);
  if (action.tool === "inspect_field") {
    const field = state.context.page.fields.find((field) => field.id === action.fieldId);
    if (!field || field.disabled || ["credential", "file", "signature", "checkbox"].includes(field.kind)
      || !fieldKey(state.context, field.id) || state.inspections?.[fieldKey(state.context, field.id)]) return { allowed: false, code: "UNVALIDATED_INSPECT_TARGET" };
  }
  if (["fill_field", "retry_field"].includes(action.tool)) {
    const list = action.tool === "fill_field" ? available.pending : available.retryable;
    const item = list.find((field) => field.fieldId === action.fieldId && field.sourcePath === action.sourcePath);
    if (!item || !fieldKey(state.context, action.fieldId)) return { allowed: false, code: "UNVALIDATED_FILL_TARGET" };
    if (state.writes >= state.limits.maxWrites) return { allowed: false, code: "WRITE_BUDGET_EXHAUSTED" };
    return { allowed: true, item };
  }
  if (action.tool === "add_entry") {
    if (!available.missingEntries.some((group) => group.groupId === action.groupId)) return { allowed: false, code: "UNVALIDATED_ADD_TARGET" };
    if (state.added >= state.limits.maxAdds) return { allowed: false, code: "ADD_BUDGET_EXHAUSTED" };
  }
  if (["finish", "request_review"].includes(action.tool) && state.receipts.some((item) => item.verified) && state.auditEpoch !== state.mutationEpoch)
    return { allowed: false, code: "FINAL_AUDIT_REQUIRED" };
  return { allowed: true };
}
export function modelContext(state) {
  const available = candidates(state);
  const project = (item) => ({ fieldId: item.fieldId, sourcePath: item.sourcePath, label: item.label,
    kind: item.kind, groupId: item.groupId, entryIndex: item.entryIndex, status: item.status });
  return { goal: "使用资料库填写当前简历，保留缺失与失败结果供人工核对，严禁自动提交", snapshotId: state.context.snapshotId,
    page: state.context.page, profileCatalog: state.context.profileCatalog, fillMode: state.context.fillMode,
    fieldCoverage: fieldCoverage(state.context, state.plan, state.receipts),
    inspections: Object.values(state.inspections || {}),
    inspectableFields: state.context.page.fields.filter((field) => !field.disabled && !["credential", "file", "signature", "checkbox"].includes(field.kind)
      && fieldKey(state.context, field.id) && !state.inspections?.[fieldKey(state.context, field.id)] && !field.knownSourcePath)
      .map(({ id: fieldId, label, kind, component }) => ({ fieldId, label, kind, ...(component ? { component } : {}) })),
    planAvailable: Boolean(state.plan), pendingFields: available.pending.map(project), retryableFields: available.retryable.map(project),
    missingEntries: available.missingEntries, unresolved: state.plan?.items.filter((item) => !item.sourcePath || !EXECUTABLE.has(item.status) || !fieldKey(state.context, item.fieldId))
      .map((item) => item.sourcePath && EXECUTABLE.has(item.status) && !fieldKey(state.context, item.fieldId)
        ? { ...item, status: "ambiguous_mapping", reason: "ambiguous_field_identity" } : item) || [],
    receipts: state.receipts.map(({ key, ...item }) => item), lastResult: state.lastResult,
    reviewIntent: state.reviewIntent || null,
    recentHistory: state.history.slice(-16), planFailure: state.planFailure,
    auditRequired: state.receipts.some((item) => item.verified) && state.auditEpoch !== state.mutationEpoch,
    remainingBudget: { steps: state.limits.maxSteps - state.steps, writes: state.limits.maxWrites - state.writes,
      adds: state.limits.maxAdds - state.added },
  };
}
