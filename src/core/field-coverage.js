import { configurationFor, normalizeQuestion } from "./question-choices.js";
import { fieldMappingCompatible } from "./field-semantics.js";

/** Measured inventory, not a filling policy. Never infer an answer from a blank. */
export function fieldCoverage(context, plan, receipts = []) {
  if (!context) return [];
  return context.page.fields.map((field) => {
    const item = plan?.items.find((item) => item.fieldId === field.id);
    const receipt = receipts.find((r) => r.fieldId === field.id);
    const proposedPath = item?.sourcePath || receipt?.sourcePath || field.knownSourcePath;
    const groupLabel = context.page.groups.find((group) => group.id === field.groupId)?.label;
    const source = context.profileCatalog.find((fact) => fact.path === proposedPath);
    const sourcePath = source && fieldMappingCompatible(field, source, groupLabel) ? proposedPath : null;
    const config = configurationFor(field);
    const candidateSources = context.profileCatalog.filter((fact) => {
      if (!fieldMappingCompatible(field, fact, groupLabel)) return false;
      if (sourcePath === fact.path) return true;
      if (config.section === "customAnswers") return /^formAnswers\.customAnswer\d+$/.test(fact.path)
        && normalizeQuestion(fact.label) === normalizeQuestion(config.question);
      const originals = [fact.path, ...(fact.derivedFrom || [])];
      return originals.some((path) => new RegExp(`^${config.section}\\.(?:\\d+\\.)?${config.property}$`).test(path));
    }).map((fact) => fact.path);
    const configured = Boolean(sourcePath || candidateSources.length);
    let status;
    if (["file", "checkbox", "signature", "credential"].includes(field.kind) || item?.status === "manual_only") status = "manual_only";
    else if (receipt?.verified) status = sourcePath ? "filled_verified" : "needs_review";
    else if (receipt?.code === "DATE_PRECISION_INCOMPATIBLE") status = "needs_date_confirmation";
    else if (receipt?.code === "DICTIONARY_NOT_LOADED") status = "dictionary_unavailable";
    else if (receipt?.code === "PICKER_CONTEXT_NOT_READY") status = "page_initialization_incomplete";
    else if (receipt && receipt.code !== "PROTECTED") status = /CONTROL_UNSUPPORTED|PICKER_API_UNAVAILABLE|CALENDAR_NOT_LOADED/.test(receipt.code)
      ? "unsupported_control" : "execution_failed";
    else if (field.hasValue === true) status = "existing_value_unverified";
    else if (configured) status = field.readOnly && !field.component && ["text", "number", "textarea"].includes(field.kind)
      ? "unsupported_control" : "configured_unmapped";
    else status = !plan ? "not_planned" : ["unmapped", "ambiguous_mapping", "source_conflict", "source_unverified", "label_missing"].includes(item?.status)
      ? "needs_review" : "missing_profile";
    return { fieldId: field.id, label: field.label, groupId: field.groupId, kind: field.kind,
      ...(field.questionContext ? { questionContext: field.questionContext } : {}),
      ...(field.choiceOptions ? { choiceOptions: field.choiceOptions } : {}),
      configured, status, ...(sourcePath ? { sourcePath } : {}),
      ...(receipt?.code ? { code: receipt.code } : {}), candidateSources, configuration: config };
  });
}
