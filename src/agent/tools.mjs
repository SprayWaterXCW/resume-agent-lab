import { z } from "zod";

const id = z.string().min(1).max(140);
const snapshotId = z.string().regex(/^[a-f0-9]{64}$/);
const common = { snapshotId };
export const actionSchemas = {
  plan_fields: z.object({ tool: z.literal("plan_fields"), ...common }).strict(),
  inspect_field: z.object({ tool: z.literal("inspect_field"), ...common, fieldId: id }).strict(),
  fill_field: z.object({ tool: z.literal("fill_field"), ...common, fieldId: id, sourcePath: id }).strict(),
  retry_field: z.object({ tool: z.literal("retry_field"), ...common, fieldId: id, sourcePath: id }).strict(),
  add_entry: z.object({ tool: z.literal("add_entry"), ...common, groupId: id }).strict(),
  audit: z.object({ tool: z.literal("audit"), ...common }).strict(),
  wait: z.object({ tool: z.literal("wait"), ...common, milliseconds: z.number().int().min(100).max(1000) }).strict(),
  request_review: z.object({ tool: z.literal("request_review"), ...common,
    reason: z.enum(["missing_data", "ambiguous_mapping", "unsupported_control", "repeated_failure", "user_check"]) }).strict(),
  finish: z.object({ tool: z.literal("finish"), ...common }).strict(),
};
export const actionSchema = z.discriminatedUnion("tool", Object.values(actionSchemas));
export const decisionSchema = z.object({
  evaluation: z.enum(["success", "failure", "uncertain", "not_applicable"]),
  nextGoal: z.string().min(1).max(240),
  action: actionSchema,
  deferredActions: z.array(actionSchema).max(7).default([]),
}).strict();
export const decisionDiagnosticSchema = z.object({
  stage: z.enum(["output_truncated", "tool_call_count", "tool_name", "arguments_json", "arguments_schema"]),
  callCount: z.number().int().min(0).max(100).optional(),
  issues: z.array(z.object({ field: z.enum(["snapshotId", "fieldId", "sourcePath", "groupId", "milliseconds", "evaluation", "nextGoal", "tool", "other"]),
    code: z.enum(["invalid_type", "invalid_value", "invalid_format", "too_small", "too_big", "unrecognized_keys", "other"]) }).strict()).max(12).optional(),
}).strict();
const invalid = (code, decisionDiagnostic) => Object.assign(new Error(code), { code, decisionDiagnostic });
const descriptions = {
  plan_fields: "Request a grounded mapping plan for the current observation. This tool only proposes mappings; it never fills the form. Invalid proposals return evidence for another decision.",
  inspect_field: "Inspect one observed field's available native choices, widget protocol and page readiness, without choosing an answer or changing data. Useful before planning an unfamiliar control or after an option/adapter failure. Never invent choices; use its fieldId from inspectableFields.",
  fill_field: "Fill exactly one pending field using its validated source path. Only current pendingFields are writable. The tool performs control and page-state verification.",
  retry_field: "Use the existing alternate browser event commit method for one failed write. Only retryableFields are allowed; never blindly repeat a verified write.",
  add_entry: "Add one experience card in a validated missingEntries group. Existing fields do not need to be filled first; choose the order from current evidence. Replanning follows a structural change.",
  audit: "Recheck all current write receipts, including page input state. Required after the last mutation before finishing or pausing for review. Readback does not establish server-side acceptance.",
  wait: "Wait briefly for controls to render, then observe again. This never clicks a page control.",
  request_review: "Pause this task for missing independent answers, date rules or human checks. Audit first if required, then request this pause again; resume continues observation and a new decision without submission permission.",
  finish: "End this filling task when no useful action or human input remains. For missing independent answers or a deferred reviewIntent, audit then request_review to keep the task resumable. No button is clicked; never claim submission or server acceptance.",
};
export const modelTools = Object.entries(actionSchemas).map(([name, schema]) => ({
  type: "function", function: { name, description: descriptions[name],
    parameters: z.toJSONSchema(schema.omit({ tool: true }).extend({
      evaluation: decisionSchema.shape.evaluation,
      nextGoal: decisionSchema.shape.nextGoal.describe("Brief user-facing purpose of the next action, grounded in current metadata. Do not provide hidden reasoning or any profile value."),
    }), { target: "draft-7" }),
  },
}));

export function decodeDecision(response) {
  const calls = response?.choices?.[0]?.message?.tool_calls;
  if (response?.choices?.[0]?.finish_reason === "length") throw invalid("AGENT_DECISION_INVALID", { stage: "output_truncated" });
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 8)
    throw invalid("AGENT_DECISION_INVALID", { stage: "tool_call_count", callCount: Array.isArray(calls) ? Math.min(calls.length, 100) : 0 });
  const decisions = calls.map((call) => {
  if (call.type !== "function" || !Object.hasOwn(actionSchemas, call.function?.name))
    throw invalid("AGENT_TOOL_NOT_ALLOWED", { stage: "tool_name" });
  let args;
  try { args = JSON.parse(call.function.arguments); } catch {
    throw invalid("AGENT_DECISION_INVALID", { stage: "arguments_json" });
  }
  const { evaluation, nextGoal, ...action } = args || {};
  const checked = decisionSchema.safeParse({ evaluation, nextGoal, action: { ...action, tool: call.function.name } });
  if (!checked.success) {
    const fields = ["snapshotId", "fieldId", "sourcePath", "groupId", "milliseconds", "evaluation", "nextGoal", "tool"];
    const codes = ["invalid_type", "invalid_value", "invalid_format", "too_small", "too_big", "unrecognized_keys"];
    throw invalid("AGENT_DECISION_INVALID", { stage: "arguments_schema", issues: checked.error.issues.slice(0, 12).map((issue) => ({
      field: fields.includes(issue.path.at(-1)) ? issue.path.at(-1) : "other", code: codes.includes(issue.code) ? issue.code : "other",
    })) });
  }
  return checked.data;
  });
  // Some providers return batches despite parallel_tool_calls=false. All schemas must pass.
  // Only the first MODEL-selected action is admitted; deferred actions never execute against an old snapshot.
  return { ...decisions[0], deferredActions: decisions.slice(1).map((decision) => decision.action) };
}
