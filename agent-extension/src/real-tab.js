import { isScannableUrl, readFormStructure } from "./page-scan.js";
import { formStructureDifference, sameFillTargets } from "../../src/core/form-structure-identity.js";
import { fieldMappingCompatible } from "../../src/core/field-semantics.js";
import { safeControlDiagnostic } from "../../src/core/control-diagnostics.js";
import { resolveFillMode } from "../../src/core/fill-mode.js";
import { commitPageInput } from "./page-input-commit.js";
import { openLegacyPicker, inspectPickerRuntime, inspectAreaLoad } from "./legacy-picker.js";

function realError(code) { return Object.assign(new Error(code), { code }); }
// Read-only document binding; no MAIN-world API replacements or event blockers.
export async function bindFormDocument(selection, { scripting = chrome.scripting, tabs = chrome.tabs, onStage = () => {} } = {}) {
  const assertSelection = async () => {
    if (!Number.isInteger(selection?.tabId) || !isScannableUrl(selection?.url)) throw realError("REAL_INVALID_PAGE");
    let tab;
    try { tab = await tabs.get(selection.tabId); } catch { throw realError("REAL_PAGE_CHANGED"); }
    if (tab.url !== selection.url) throw realError("REAL_PAGE_CHANGED");
  };
  onStage("CHECK_TAB");
  await assertSelection();
  onStage("BIND_DOCUMENT");
  let outputs;
  try {
    outputs = await scripting.executeScript({ target: { tabId: selection.tabId, frameIds: [0] }, world: "ISOLATED", injectImmediately: true,
      func: function readFormDocument(expectedUrl) { return { matched: location.href === expectedUrl, readyState: document.readyState }; }, args: [selection.url] });
  } catch { throw realError("REAL_PAGE_CHANGED"); }
  onStage("VERIFY_DOCUMENT");
  await assertSelection();
  if (outputs.length !== 1 || outputs[0].frameId !== 0 || outputs[0].result?.matched !== true
    || typeof outputs[0].documentId !== "string" || !outputs[0].documentId) throw realError("REAL_DOCUMENT_UNVERIFIED");
  if (outputs[0].result.readyState === "loading") onStage("DOCUMENT_STILL_LOADING");
  return outputs[0].documentId;
}

/** Chrome executes a bundled runtime in its isolated world. Values never return from DOM writes. */
export class ChromeFormEnvironment {
  constructor(selection, { scripting = chrome.scripting, tabs = chrome.tabs, documentId, monthStartDay = false, fillMode = "overwrite" } = {}) {
    if (!Number.isInteger(selection?.tabId) || !isScannableUrl(selection?.url)) throw realError("REAL_INVALID_PAGE");
    this.selection = selection; this.scripting = scripting; this.tabs = tabs;
    if (typeof documentId !== "string" || !documentId) throw realError("REAL_DOCUMENT_UNVERIFIED");
    this.target = { tabId: selection.tabId, documentIds: [documentId] };
    this.documentId = documentId;
    this.monthStartDay = monthStartDay === true;
    this.fillMode = resolveFillMode(fillMode);
    this.installed = false; this.token = null;
    this.report = null;
  }

  async assertPage() {
    let tab;
    try { tab = await this.tabs.get(this.selection.tabId); } catch { throw realError("REAL_PAGE_CHANGED"); }
    if (tab.url !== this.selection.url) throw realError("REAL_PAGE_CHANGED");
  }

  async invoke(method, argument) {
    await this.assertPage();
    let outputs;
    try { outputs = await this.scripting.executeScript({
      target: this.target, world: "ISOLATED", injectImmediately: true,
      func: (name, args) => {
        if (!["scan", "fill", "add", "audit", "clear", "repair", "inspect", "describeControl", "finishPicker", "finishCommit", "prepareCommitAudit", "finishCommitAudit"].includes(name) || !globalThis.__resumeAgentRuntime) throw new Error("REAL_RUNTIME_MISSING");
        return globalThis.__resumeAgentRuntime[name](args);
      }, args: [method, argument],
    }); } catch { throw realError("REAL_PAGE_CHANGED"); }
    await this.assertPage();
    if (outputs.length !== 1 || outputs[0].frameId !== 0) throw realError("REAL_FRAME_UNSUPPORTED");
    if (outputs[0].documentId !== this.documentId) throw realError("REAL_PAGE_CHANGED");
    return outputs[0].result;
  }

  async observe() {
    if (!this.installed) {
      await this.assertPage();
      try { await this.scripting.executeScript({ target: this.target, world: "ISOLATED", injectImmediately: true, files: ["dist/real-page.js"] }); }
      catch { throw realError("REAL_PAGE_CHANGED"); }
      this.installed = true;
    }
    const observation = await this.invoke("scan", this.selection.url);
    if (!observation?.token || observation.report?.mode !== "read-only") throw realError("REAL_SCAN_INVALID");
    this.token = observation.token;
    this.report = observation.report;
    return observation.report;
  }

  async refreshBindings() {
    const previous = this.report;
    const current = await this.observe();
    const difference = formStructureDifference(previous, current);
    if (!sameFillTargets(previous, current)) throw Object.assign(realError("REAL_FORM_STRUCTURE_CHANGED"), { structureDiagnostic: difference });
    this.bindingRefreshDifference = difference;
    return current;
  }

  async waitForForm({ shouldStop = () => false, timeoutMs = 10_000 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (shouldStop()) throw realError("USER_STOPPED");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const report = await this.observe(); // Still bound to the original document.
      if (report.fields.length || report.controls.some((control) => control.intent === "add-candidate")) return true;
    }
    return false;
  }

  async fill(item, ledger, { browserEditRetry = false } = {}) {
    if (!ledger.hasPath(item.sourcePath)) return { code: "SOURCE_UNAVAILABLE", verified: false };
    const observed = this.report?.fields.find((field) => field.id === item.fieldId);
    const fact = ledger.publicFacts?.find((fact) => fact.path === item.sourcePath);
    if (observed && fact && !fieldMappingCompatible(observed, fact, this.report.groups.find((group) => group.id === observed.groupId)?.label)) {
      return { code: "SEMANTIC_MAPPING_MISMATCH", verified: false };
    }
    const region = ["formAnswers.hometown", "formAnswers.studentOrigin"].includes(item.sourcePath)
      ? ledger.publicFacts?.find((fact) => fact.path === item.sourcePath) : null;
    const regionParts = region?.derivation === "region_join" ? (region.derivedFrom || []).filter((path) =>
      /^contactAndLocation\.(hometown|studentOrigin)(Province|City|District)$/.test(path) && ledger.hasPath(path)).map((path) => ledger.getValue(path)) : [];
    const argument = { fieldId: item.fieldId, sourcePath: item.sourcePath,
      ...(item.semanticRole ? { semanticRole: item.semanticRole } : {}),
      value: ledger.getValue(item.sourcePath), regionParts, monthStartDay: this.monthStartDay, browserEditRetry, fillMode: this.fillMode, requirePageCommit: true };
    let outcome = await this.invoke("fill", { ...argument, token: this.token });
    outcome = await this.completeInputCommit(outcome);
    if (outcome?.code === "REAL_FIELD_BINDING_STALE") {
      await this.refreshBindings();
      outcome = await this.invoke("fill", { ...argument, token: this.token });
      outcome = await this.completeInputCommit(outcome);
      outcome.diagnostic = { ...outcome.diagnostic, bindingRefreshed: true, structureMatched: true, bindingRefreshCount: 1 };
      if (this.bindingRefreshDifference?.changedCount) outcome.structureDiagnostic = this.bindingRefreshDifference;
    }
    return this.safeOutcome(outcome);
  }

  async retryFill(item, ledger) { return this.fill(item, ledger, { browserEditRetry: true }); }

  async pageInput(request) {
    await this.assertPage();
    let outputs;
    try { outputs = await this.scripting.executeScript({ target: this.target, world: "MAIN", injectImmediately: true,
      func: commitPageInput, args: [request, this.selection.url] }); }
    catch { throw realError("PAGE_INPUT_EXECUTION_FAILED"); }
    await this.assertPage();
    if (outputs.length !== 1 || outputs[0].frameId !== 0 || outputs[0].documentId !== this.documentId) throw realError("REAL_PAGE_CHANGED");
    // Only the fixed Boolean diagnostic whitelist returns from the page world.
    return safeControlDiagnostic(outputs[0].result) || {};
  }

  async completeInputCommit(outcome) {
    if (outcome?.code === "LEGACY_PICKER_PENDING") {
      await this.assertPage();
      const outputs = await this.scripting.executeScript({ target: this.target, world: "MAIN", injectImmediately: true,
        func: openLegacyPicker, args: [outcome.pickerRequest, this.selection.url] });
      await this.assertPage();
      if (outputs.length !== 1 || outputs[0].documentId !== this.documentId) throw realError("REAL_PAGE_CHANGED");
      const completed = await this.invoke("finishPicker", { token: this.token, ticket: outcome.pickerRequest.ticket,
        evidence: { opened: outputs[0].result?.opened === true, contextReady: outputs[0].result?.code !== "PICKER_CONTEXT_NOT_READY" } });
      if (completed?.code === "DICTIONARY_NOT_LOADED") {
        const diagnosis = await this.scripting.executeScript({ target: this.target, world: "MAIN", injectImmediately: true,
          func: inspectAreaLoad, args: [this.selection.url] });
        await this.assertPage();
        if (diagnosis.length !== 1 || diagnosis[0].documentId !== this.documentId) throw realError("REAL_PAGE_CHANGED");
        completed.diagnostic = { ...completed.diagnostic, ...safeControlDiagnostic(diagnosis[0].result) };
      }
      return completed;
    }
    if (outcome?.code !== "PAGE_COMMIT_PENDING") return outcome;
    const request = outcome.commitRequest;
    if (!/^[a-f0-9-]{36}$/.test(request?.ticket || "") || typeof request.value !== "string") throw realError("REAL_RESULT_INVALID");
    let evidence;
    try { evidence = await this.pageInput(request); }
    catch (error) {
      await this.invoke("finishCommit", { token: this.token, ticket: request.ticket, evidence: {} }).catch(() => {});
      throw error;
    }
    const finalized = await this.invoke("finishCommit", { token: this.token, ticket: request.ticket, evidence });
    if (outcome.completedDay) finalized.completedDay = true;
    if (Number.isInteger(outcome.optionCount)) finalized.optionCount = outcome.optionCount;
    return finalized;
  }

  async repairPreviousWrites(previous, ledger) {
    await this.assertPage();
    // Chrome clears session storage when an unpacked extension reloads. The
    // page's existing isolated runtime can still prove its own writes. Inspect
    // that live receipt owner before replacing it; never infer ownership merely
    // from a profile value or a saved execution log.
    const reports = await this.scripting.executeScript({ target: this.target, world: "ISOLATED", injectImmediately: true, func: function readPreviousAgentReport(expectedUrl) {
      if (location.href !== expectedUrl || !globalThis.__resumeAgentRuntime?.scan) return null;
      return globalThis.__resumeAgentRuntime.scan(expectedUrl).report;
    }, args: [this.selection.url] });
    await this.assertPage();
    if (reports.length !== 1 || reports[0].documentId !== this.documentId) throw realError("REAL_PAGE_CHANGED");
    let priorReport = reports[0].result;
    if (!Array.isArray(priorReport?.fields)) {
      const fresh = await this.scripting.executeScript({ target: this.target, world: "ISOLATED", injectImmediately: true, func: readFormStructure, args: [this.selection.url, false] });
      await this.assertPage();
      if (fresh.length !== 1 || fresh[0].documentId !== this.documentId) throw realError("REAL_PAGE_CHANGED");
      priorReport = fresh[0].result;
    }
    if (!Array.isArray(priorReport?.fields)) return [];
    const targets = priorReport.fields.filter((field) => ["text", "textarea", "number"].includes(field.kind) && !field.disabled && !field.readOnly)
      .flatMap((field) => ledger.publicFacts.filter((fact) => ledger.hasPath(fact.path) && !fieldMappingCompatible(field, fact,
        priorReport.groups.find((group) => group.id === field.groupId)?.label)).map((fact) => ({ fieldId: field.id,
        sourcePath: fact.path, label: field.label, kind: field.kind, groupId: field.groupId, entryIndex: field.entryIndex })));
    if (!targets.length) return [];
    const outputs = await this.scripting.executeScript({ target: this.target, world: "ISOLATED", injectImmediately: true, func: async function provePreviousAgentWrites(expectedUrl, candidates) {
      const runtime = globalThis.__resumeAgentRuntime;
      if (location.href !== expectedUrl || !runtime?.scan || !runtime?.audit) return [];
      const observed = runtime.scan(expectedUrl);
      const exact = candidates.filter((target) => observed.report.fields.some((field) => field.id === target.fieldId
        && field.label === target.label && field.kind === target.kind && field.groupId === target.groupId && field.entryIndex === target.entryIndex));
      return runtime.audit({ token: observed.token, targets: exact.map(({ fieldId, sourcePath }) => ({ fieldId, sourcePath })) })
        .filter((outcome) => outcome.verified).map(({ fieldId, sourcePath }) => ({ fieldId, sourcePath }));
    }, args: [this.selection.url, targets] });
    await this.assertPage();
    if (outputs.length !== 1 || outputs[0].documentId !== this.documentId || !Array.isArray(outputs[0].result)) throw realError("REAL_PAGE_CHANGED");
    const proven = outputs[0].result;
    await this.observe();
    const matches = await this.invoke("inspect", { token: this.token, candidates: targets.map((item) => ({
      fieldId: item.fieldId, sourcePath: item.sourcePath, fact: ledger.publicFacts.find((fact) => fact.path === item.sourcePath), expectedValue: ledger.getValue(item.sourcePath),
    })) });
    if (!Array.isArray(matches)) throw realError("REAL_RESULT_INVALID");
    const results = [];
    const suspects = previous?.selectedTabId === this.selection.tabId && previous.selectedUrl === this.selection.url ? previous.outcomes || [] : [];
    for (const item of targets.filter((target) => proven.some((proof) => proof.fieldId === target.fieldId && proof.sourcePath === target.sourcePath)
      || matches.some((match) => match.fieldId === target.fieldId && match.sourcePath === target.sourcePath)
      || suspects.some((outcome) => outcome.fieldId === target.fieldId && outcome.sourcePath === target.sourcePath && outcome.verified))) {
      const verified = proven.some((proof) => proof.fieldId === item.fieldId && proof.sourcePath === item.sourcePath);
      const argument = { fieldId: item.fieldId, sourcePath: item.sourcePath, fact: ledger.publicFacts.find((fact) => fact.path === item.sourcePath),
        expectedValue: ledger.getValue(item.sourcePath), receiptVerified: true };
      let raw = verified ? await this.invoke("repair", { token: this.token, ...argument }) : {
        code: matches.some((match) => match.fieldId === item.fieldId && match.sourcePath === item.sourcePath) ? "EXISTING_SEMANTIC_REVIEW" : "REPAIR_RECEIPT_UNAVAILABLE", verified: false };
      if (raw.code === "REAL_FIELD_BINDING_STALE") { await this.refreshBindings(); raw = await this.invoke("repair", { token: this.token, ...argument }); }
      const outcome = this.safeOutcome(raw);
      results.push({ tool: "semantic_repair", ...item, ...outcome });
    }
    return results;
  }

  async clear() {
    if (this.installed) await this.invoke("clear");
    this.installed = false; this.token = null; this.report = null;
  }

  async inspect(fieldId) {
    const control = await this.invoke("describeControl", { token: this.token, fieldId });
    await this.assertPage();
    const outputs = await this.scripting.executeScript({ target: this.target, world: "MAIN", injectImmediately: true,
      func: inspectPickerRuntime, args: [this.selection.url] });
    await this.assertPage();
    if (outputs.length !== 1 || outputs[0].documentId !== this.documentId) throw realError("REAL_PAGE_CHANGED");
    return { ...control, ...safeControlDiagnostic(outputs[0].result), code: "CONTROL_INSPECTED" };
  }

  async add(groupId) {
    return this.safeOutcome(await this.invoke("add", { token: this.token, groupId }));
  }

  async audit(targets) {
    let outcomes = await this.invoke("audit", { token: this.token, targets });
    let refreshed = false;
    if (Array.isArray(outcomes) && outcomes.some((outcome) => outcome.code === "REAL_FIELD_BINDING_STALE")) {
      await this.refreshBindings(); refreshed = true;
      outcomes = await this.invoke("audit", { token: this.token, targets });
    }
    if (!Array.isArray(outcomes) || outcomes.length !== targets.length) throw realError("REAL_RESULT_INVALID");
    const checks = await this.invoke("prepareCommitAudit", { token: this.token, targets });
    if (!Array.isArray(checks) || checks.length > targets.length) throw realError("REAL_RESULT_INVALID");
    for (const check of checks) {
      const index = targets.findIndex((item) => item.fieldId === check.fieldId && item.sourcePath === check.sourcePath);
      if (index < 0) throw realError("REAL_RESULT_INVALID");
      let evidence;
      try { evidence = await this.pageInput(check); }
      catch (error) {
        await this.invoke("finishCommitAudit", { token: this.token, ticket: check.ticket, evidence: {} }).catch(() => {});
        throw error;
      }
      const final = await this.invoke("finishCommitAudit", { token: this.token, ticket: check.ticket, evidence });
      if (!final.verified || outcomes[index].verified) outcomes[index] = { ...targets[index], ...final };
    }
    return outcomes.map((outcome, index) => {
      if (outcome.fieldId !== targets[index].fieldId || outcome.sourcePath !== targets[index].sourcePath) throw realError("REAL_RESULT_INVALID");
      if (refreshed) outcome.diagnostic = { ...outcome.diagnostic, bindingRefreshed: true, structureMatched: true, bindingRefreshCount: 1 };
      if (refreshed && this.bindingRefreshDifference?.changedCount) outcome.structureDiagnostic = this.bindingRefreshDifference;
      return { ...targets[index], ...this.safeOutcome(outcome) };
    });
  }

  safeOutcome(outcome) {
    if (!outcome || !/^[A-Z_]+$/.test(outcome.code || "") || typeof outcome.verified !== "boolean") throw realError("REAL_RESULT_INVALID");
    const safe = { code: outcome.code, verified: outcome.verified };
    for (const key of ["optionCount", "candidateCount", "entryCount"]) {
      if (Number.isInteger(outcome[key]) && outcome[key] >= 0 && outcome[key] <= 1000) safe[key] = outcome[key];
    }
    if (outcome.completedDay === true) safe.completedDay = true;
    const structure = structureDiagnosticSchema.safeParse(outcome.structureDiagnostic);
    if (structure.success) safe.structureDiagnostic = structure.data;
    const diagnostic = safeControlDiagnostic(outcome.diagnostic);
    if (diagnostic) safe.diagnostic = diagnostic;
    return safe;
  }
}
import { structureDiagnosticSchema } from "../../src/core/execution-diagnostics.js";
