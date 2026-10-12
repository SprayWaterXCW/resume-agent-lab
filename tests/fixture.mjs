import { createPlanContext } from "../src/core/fill-plan.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { labProfile } from "../src/fixtures/lab-profile.mjs";

export function createFixture({ failFirstMajor = false, dropOnAudit = false, extraField = false } = {}) {
  const ledger = ledgerFromProfile(importProfile(labProfile).stored);
  const fields = [
    { id: "field-1", groupId: "group-1", label: "姓名", entryIndex: 0 },
    { id: "field-2", groupId: "group-1", label: "邮箱", entryIndex: 0 },
    { id: "field-3", groupId: "group-2", label: "毕业学校", entryIndex: 0 },
    { id: "field-4", groupId: "group-2", label: "所学专业", entryIndex: 0 },
  ].map((f) => ({ ...f, labelSource: "label", kind: "text", required: true, disabled: false,
    readOnly: false, hasValue: false, valueExcluded: false, entrySource: "explicit" }));
  if (extraField) fields.push({ ...fields[0], id: "field-extra", label: "未配置的问题" });
  const groups = [{ id: "group-1", label: "基本信息", entryCount: 1, source: "explicit" },
    { id: "group-2", label: "教育经历", entryCount: 1, source: "explicit" }];
  const calls = [], privateValues = new Map(); let failed = false;
  const environment = {
    async observe({ verifiedMappings = [] } = {}) {
      calls.push({ tool: "observe" });
      return createPlanContext({ mode: "read-only", origin: "http://127.0.0.1:4175", groups: structuredClone(groups),
        fields: structuredClone(fields), controls: [{ intent: "add-candidate", groupId: "group-2" }], summary: { truncated: false } }, ledger, { verifiedMappings });
    },
    async fill(item, { retry = false } = {}) {
      calls.push({ tool: retry ? "retry_field" : "fill_field", fieldId: item.fieldId, sourcePath: item.sourcePath });
      const field = fields.find((f) => f.id === item.fieldId);
      if (failFirstMajor && field.label === "所学专业" && !failed) {
        failed = true; return { code: "READBACK_MISMATCH", verified: false, diagnostic: { phase: "commit", adapter: "native_text", pageStateObserved: true, pageStateMatched: false } };
      }
      privateValues.set(item.fieldId, ledger.getValue(item.sourcePath)); field.hasValue = true;
      return { code: "VERIFIED", verified: true, diagnostic: { phase: "commit", adapter: "native_text", pageStateObserved: true, pageStateMatched: true,
        identityVerified: true, valueMatched: true, validityValid: true } };
    },
    async add(groupId) {
      calls.push({ tool: "add_entry", groupId }); const group = groups.find((g) => g.id === groupId); const entryIndex = group.entryCount++;
      for (const label of ["毕业学校", "所学专业"]) fields.push({ ...fields[2], id: "field-" + (fields.length + 1), label, entryIndex, hasValue: false });
      return { code: "ENTRY_ADDED", verified: true };
    },
    async audit(targets) {
      calls.push({ tool: "audit" });
      if (dropOnAudit && targets.length) { fields.find((f) => f.id === targets[0].fieldId).hasValue = false; privateValues.delete(targets[0].fieldId); }
      return targets.map((target) => ({ ...target, code: privateValues.get(target.fieldId) === ledger.getValue(target.sourcePath) ? "VERIFIED" : "READBACK_MISMATCH",
        verified: privateValues.get(target.fieldId) === ledger.getValue(target.sourcePath),
        diagnostic: { phase: "audit", adapter: "native_text", pageStateObserved: true,
          pageStateMatched: privateValues.get(target.fieldId) === ledger.getValue(target.sourcePath) } }));
    },
    async wait() { calls.push({ tool: "wait" }); },
  };
  const planner = {
    async planMappings(context) {
      const mapping = (f) => f.label === "姓名" ? "personal.fullName" : f.label === "邮箱" ? "personal.email"
        : f.label === "毕业学校" ? `educations.${f.entryIndex}.school` : f.label === "所学专业" ? `educations.${f.entryIndex}.major` : null;
      return { snapshotId: context.snapshotId, groupMappings: [{ groupId: "group-1", sectionKeys: ["personal"] },
        { groupId: "group-2", sectionKeys: ["educations"] }],
      fieldMappings: context.page.fields.filter((f) => mapping(f)).map((f) => ({ fieldId: f.id, sourcePath: mapping(f) })),
      unresolved: context.page.fields.filter((f) => !mapping(f)).map((f) => ({ fieldId: f.id, reason: "missing_profile" })) };
    },
  };
  return { ledger, fields, groups, calls, privateValues, environment, planner };
}

/** Explicit test double. Never used by service/main.mjs or the Chrome runtime. */
export function scriptedModel({ addFirst = false } = {}) {
  const contexts = [];
  return { contexts, async decide(context) {
    contexts.push(structuredClone(context));
    let action;
    if (!context.planAvailable) action = { tool: "plan_fields" };
    else if (addFirst && context.missingEntries.length) action = { tool: "add_entry", groupId: context.missingEntries[0].groupId };
    else if (context.retryableFields.length) { const item = context.retryableFields[0]; action = { tool: "retry_field", fieldId: item.fieldId, sourcePath: item.sourcePath }; }
    else if (context.pendingFields.length) { const item = context.pendingFields[0]; action = { tool: "fill_field", fieldId: item.fieldId, sourcePath: item.sourcePath }; }
    else if (context.missingEntries.length) action = { tool: "add_entry", groupId: context.missingEntries[0].groupId };
    else if (context.auditRequired) action = { tool: "audit" };
    else action = { tool: "finish" };
    return { evaluation: context.lastResult?.verified === false ? "failure" : "uncertain", nextGoal: "按测试场景选择下一项工具（脚本替身）",
      action: { ...action, snapshotId: context.snapshotId } };
  } };
}
