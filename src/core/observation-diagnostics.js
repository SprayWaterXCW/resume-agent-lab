import { z } from "zod";

const count = z.number().int().min(0).max(10_000_000);
const keys = ["schemaVersion", "profileKind", "fillMode", "profileRevision", "snapshotId", "page", "origin", "truncated",
  "groups", "fields", "id", "groupId", "entryIndex", "entryCount", "hasAddCandidate", "source", "label", "labelSource", "kind",
  "required", "disabled", "readOnly", "hasValue", "valueExcluded", "optionLabel", "choiceOptions", "questionContext", "component",
  "entrySource", "datePart", "dateRole", "knownSourcePath", "profileCatalog", "path", "sectionKey", "status", "evidenceCount",
  "derivedFrom", "derivation", "unknown_key"];
const issueCodes = ["invalid_type", "unrecognized_keys", "too_big", "too_small", "invalid_format", "invalid_value", "invalid_union", "custom", "other"];
const types = ["string", "number", "boolean", "object", "array", "null", "undefined", "other"];
export const observationDiagnosticSchema = z.object({
  version: z.literal(1), area: z.enum(["page", "profile_catalog", "context"]),
  issueCount: count, issues: z.array(z.object({ code: z.enum(issueCodes),
    path: z.array(z.union([z.enum(keys), count])).max(10), expectedType: z.enum(types).optional(),
    maximum: count.optional(), minimum: count.optional(), unknownKeyCount: count.optional(),
  }).strict()).max(20),
}).strict();

/** Keep schema locations and bounds; drop messages, inputs, enum values and unknown property names. */
export function observationDiagnostic(area, schemaError) {
  const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
  const source = Array.isArray(schemaError?.issues) ? schemaError.issues : [];
  return observationDiagnosticSchema.parse({ version: 1, area, issueCount: Math.min(source.length, 10_000_000),
    issues: source.slice(0, 20).map((issue) => ({
      code: issueCodes.includes(issue.code) ? issue.code : "other",
      path: (Array.isArray(issue.path) ? issue.path : []).slice(0, 10).map((key) =>
        typeof key === "number" ? safeCount(key) ? key : 0 : keys.includes(key) ? key : "unknown_key"),
      ...(types.includes(issue.expected) ? { expectedType: issue.expected } : {}),
      ...(safeCount(issue.maximum) ? { maximum: issue.maximum } : {}),
      ...(safeCount(issue.minimum) ? { minimum: issue.minimum } : {}),
      ...(Array.isArray(issue.keys) ? { unknownKeyCount: Math.min(issue.keys.length, 10_000_000) } : {}),
    })) });
}

export const toolFailureDiagnosticSchema = z.object({
  version: z.literal(1), method: z.enum(["observe", "fill", "add", "audit", "inspect", "wait", "unknown"]),
  stage: z.enum(["request_validation", "document_identity", "profile_reload", "page_scan", "context_build", "plan_validation", "tool_execution", "unknown"]),
  errorType: z.enum(["Error", "TypeError", "RangeError", "SyntaxError", "ZodError", "FillPlanError", "other"]),
  observation: observationDiagnosticSchema.optional(),
}).strict();

export function toolFailureDiagnostic(error, method, stage) {
  const shape = toolFailureDiagnosticSchema.shape;
  const observation = observationDiagnosticSchema.safeParse(error?.observationDiagnostic);
  return toolFailureDiagnosticSchema.parse({ version: 1,
    method: shape.method.options.includes(method) ? method : "unknown",
    stage: shape.stage.options.includes(stage) ? stage : "unknown",
    errorType: shape.errorType.options.includes(error?.name) ? error.name : "other",
    ...(observation.success ? { observation: observation.data } : {}) });
}
