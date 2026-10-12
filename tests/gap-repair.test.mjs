import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFormStructure } from "../agent-extension/src/page-scan.js";
import { fillBoundField, installRealPageRuntime } from "../agent-extension/src/real-page.js";
import { openLegacyPicker, completeLegacyPicker, inspectAreaLoad } from "../agent-extension/src/legacy-picker.js";
import { DropdownSelect } from "../src/vendor/formfill/dropdown-select.js";
import { fieldMappingCompatible } from "../src/core/field-semantics.js";
import { fieldCoverage } from "../src/core/field-coverage.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { createPlanContext, buildFillPlan } from "../src/core/fill-plan.js";
import { createResumeAgent } from "../src/agent/graph.mjs";
import { ChromeFormEnvironment } from "../agent-extension/src/real-tab.js";
import { labProfile } from "../src/fixtures/lab-profile.mjs";
import { questionChoiceValue } from "../src/core/question-choices.js";
import { createFixture, scriptedModel } from "./fixture.mjs";

async function withDOM(html, work) {
  const dom = new JSDOM(html, { url: "https://fictional-recruitment.example.test/resume" });
  const names = ["document", "location", "getComputedStyle", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Event", "jQuery", "WdatePicker", "BSGlobal", "__resumeAgentBindings", "__resumeAgentRuntime", "__resumeAgentDateDefaultCleanup"];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names.slice(0, 7)) Object.defineProperty(globalThis, name, { configurable: true, writable: true,
    value: name === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[name] });
  dom.window.Element.prototype.getClientRects = function () { return [{}]; };
  try { await work(dom.window.document, dom.window); }
  finally { globalThis.__resumeAgentDateDefaultCleanup?.(); for (const [name, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; dom.window.close(); }
}

test("descriptive confirmed color vision facts answer a yes/no question, without inferring withheld answers", async () => {
  await withDOM('<section aria-label="个人信息"><div><span>是否有色盲或色弱情况？</span><div><input type="radio" name="color" value="1"><label>是</label><input type="radio" name="color" value="0"><label>否</label></div></div></section>', async (doc) => {
    const report = readFormStructure(location.href, true), fieldId = report.fields[0].id;
    let outcome = await fillBoundField({ token: __resumeAgentBindings.token, fieldId, sourcePath: "personal.colorVision", value: "无色盲色弱" });
    assert.equal(outcome.verified, true); assert.equal(doc.querySelector('input[value="0"]').checked, true);
    outcome = await fillBoundField({ token: __resumeAgentBindings.token, fieldId, sourcePath: "personal.colorVision", value: "不方便透露" });
    assert.equal(outcome.code, "OPTION_UNAVAILABLE"); assert.equal(doc.querySelector('input[value="0"]').checked, true);
    assert.equal(readFormStructure(location.href).fields[0].hasValue, true);
  });
});

test("generic prefix matching cannot turn admission mode into a more specific degree track or reverse negation", () => {
  assert.equal(DropdownSelect.pickBestOption([{ text: "统招专升本" }], "统招"), null);
  assert.equal(DropdownSelect.pickBestOption([{ text: "不接受" }], "接受"), null);
  assert.equal(DropdownSelect.pickBestOption([{ text: "全日制（统分统招）" }, { text: "统招专升本" }], "统招").option.text, "全日制（统分统招）");
  assert.equal(DropdownSelect.pickBestOption([{ text: "全国普通高等院校全日制" }, { text: "统招专升本" }], "统招").option.text, "全国普通高等院校全日制");
  assert.equal(DropdownSelect.pickBestOption([{ text: "六级" }, { text: "专业八级" }], "英语六级").option.text, "六级");
  assert.equal(DropdownSelect.pickBestOption([{ text: "专业四级" }], "英语四级"), null);
});

test("configured address and birth facts remain visible to coverage even before mapping or after receipts become protected", async () => {
  const { stored } = importProfile({ profile: { personal: { birthDate: "2001-02-12" }, contactAndLocation: { currentAddressLine1: "FICTIONAL_ADDRESS" } } });
  const ledger = ledgerFromProfile(stored);
  const f = createFixture(), report = { mode: "read-only", origin: "http://127.0.0.1:4175", groups: [f.groups[0]], controls: [], summary: { truncated: false },
    fields: [{ ...f.fields[0], label: "通讯地址：" }, { ...f.fields[1], label: "出生日期：" }] };
  const context = await createPlanContext(report, ledger), coverage = fieldCoverage(context, null);
  assert.ok(coverage.every((field) => field.configured && field.status === "configured_unmapped"));
  assert.ok(coverage[0].candidateSources.includes("formAnswers.mailingAddress"));
  assert.equal(fieldMappingCompatible(report.fields[1], { path: "personal.email" }), false);
  const after = fieldCoverage(context, { items: [{ fieldId: "field-1", status: "protected" }] }, [{ fieldId: "field-1", sourcePath: "formAnswers.mailingAddress", code: "VERIFIED", verified: true }]);
  assert.equal(after[0].configured, true); assert.equal(after[0].sourcePath, "formAnswers.mailingAddress");
  assert.equal(JSON.stringify(after).includes("FICTIONAL_ADDRESS"), false);
  await assert.rejects(buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [], fieldMappings: [],
    unresolved: report.fields.map((field) => ({ fieldId: field.id, reason: "missing_profile" })) }), (error) => error.code === "PLAN_SEMANTIC_MISMATCH"
      && error.diagnostic.violation === "configured_source_omitted" && error.diagnostic.sourcePaths.includes("personal.birthDate"));
});

test("a failed calendar attempt retains precision diagnostics after observation and audit", async () => {
  const f = createFixture(), baseFill = f.environment.fill, regular = scriptedModel();
  f.environment.fill = (item, options) => item.fieldId === "field-1" ? { code: "DATE_PRECISION_INCOMPATIBLE", verified: false } : baseFill(item, options);
  const agent = createResumeAgent({ ...f, model: regular }); const result = await agent.run();
  assert.equal(result.outcomes.find((outcome) => outcome.fieldId === "field-1").code, "DATE_PRECISION_INCOMPATIBLE");
  assert.ok(regular.contexts.some((context) => context.fieldCoverage.some((field) => field.fieldId === "field-1" && field.status === "needs_date_confirmation")));
  await agent.dispose();
});

test("new configuration round-trips independently, latest graduation preserves precision, and unrelated facts cannot answer new questions", () => {
  const { stored } = importProfile({ profile: { personal: { fullName: "FICTIONAL_PERSON" }, educations: [{ school: "FICTIONAL_SCHOOL", endDate: "2027-06", campus: "FICTIONAL_CAMPUS" }],
    jobPreferences: { availableInternshipDate: "2027-01-12", acceptShiftWork: "否", acceptCleanroomWork: "是", jobPriorities: "FICTIONAL_PRIORITIES" },
    skills: { personalityKeywords: "FICTIONAL_WORDS" } } });
  const ledger = ledgerFromProfile(stored);
  assert.equal(ledger.getValue("formAnswers.expectedGraduationDate"), "2027-06");
  assert.equal(ledger.getValue("educations.0.campus"), "FICTIONAL_CAMPUS");
  assert.equal(ledger.hasPath("jobPreferences.availableInternshipDate"), true);
  assert.equal(fieldMappingCompatible({ label: "预计实习日期" }, { path: "jobPreferences.availableDate" }), false);
  assert.equal(fieldMappingCompatible({ label: "能否接受轮班安排" }, { path: "jobPreferences.willingToTravel" }), false);
  assert.equal(JSON.stringify(ledger.publicFacts).includes("FICTIONAL_PRIORITIES"), false);
});

test("company-relative questions need an exact contextual answer, not a name or family member fact", () => {
  const question = { label: "您是否有亲属在虚构公司工作？：", kind: "radio" };
  for (const path of ["personal.firstName", "personal.fullName", "familyMembers.0.employer", "jobPreferences.referrerName"]) {
    assert.equal(fieldMappingCompatible(question, { path }), false);
  }
  assert.equal(fieldMappingCompatible(question, { path: "formAnswers.customAnswer0", label: question.label }), true);
  assert.equal(fieldMappingCompatible(question, { path: "formAnswers.customAnswer0", label: "您是否有亲属在另一家公司工作？" }), false);
  assert.equal(fieldMappingCompatible({ label: "请填写名字", questionContext: question.label }, { path: "personal.firstName" }), false);
  const coverage = fieldCoverage({ page: { fields: [{ ...question, id: "q", knownSourcePath: "personal.firstName" }], groups: [] },
    profileCatalog: [{ path: "personal.firstName", label: "名" }] }, { items: [] }, [{ fieldId: "q", sourcePath: "personal.firstName", verified: true }]);
  assert.equal(coverage[0].configured, false); assert.equal(coverage[0].status, "needs_review");
});

test("confirmed work preferences translate only to present paired options without guessing withheld answers", () => {
  const field = { label: "如果生产需要，能否接受轮班安排？：", choiceOptions: ["能", "不能"] };
  assert.equal(questionChoiceValue(field, "jobPreferences.acceptShiftWork", "是"), "能");
  assert.equal(questionChoiceValue(field, "jobPreferences.acceptShiftWork", "否"), "不能");
  assert.equal(questionChoiceValue(field, "jobPreferences.acceptShiftWork", "接受"), "能");
  assert.equal(questionChoiceValue(field, "jobPreferences.acceptShiftWork", "暂不确定"), "暂不确定");
  assert.equal(questionChoiceValue(field, "jobPreferences.willingToTravel", "是"), "是");
  assert.equal(questionChoiceValue({ ...field, choiceOptions: ["能"] }, "jobPreferences.acceptShiftWork", "是"), "是");
});

test("annual salary requires an explicit period or independent annual amount and never assumes monthly times twelve", () => {
  const ambiguous = ledgerFromProfile(importProfile({ profile: { jobPreferences: { expectedSalary: "20万", expectedMonthlySalary: "15000" } } }).stored);
  assert.equal(ambiguous.hasPath("formAnswers.expectedAnnualSalary"), false);
  assert.equal(fieldMappingCompatible({ label: "期望年薪（税前）" }, { path: "jobPreferences.expectedSalary", label: "期望薪资" }), false);
  const explicit = ledgerFromProfile(importProfile({ profile: { jobPreferences: { expectedSalary: "20万元/年" } } }).stored);
  assert.equal(explicit.getValue("formAnswers.expectedAnnualSalary"), "200000");
  const independent = ledgerFromProfile(importProfile({ profile: { jobPreferences: { expectedAnnualSalary: "180000～240000" } } }).stored);
  assert.equal(independent.getValue("formAnswers.expectedAnnualSalary"), "180000～240000");
  assert.equal(JSON.stringify(independent.publicFacts).includes("180000～240000"), false);
});

test("conditional details keep their parent question identity and never borrow another question's answer", async () => {
  await withDOM('<section aria-label="个人信息"><ul><li><span>是否有呼吸系统疾病？</span><div><input name="a" type="radio"><label>是</label><input name="a" type="radio"><label>否</label></div></li><li><span>如是，请告知详情</span><textarea></textarea></li></ul></section>', async () => {
    const detail = readFormStructure(location.href).fields.find((f) => f.kind === "textarea");
    assert.equal(detail.questionContext, "是否有呼吸系统疾病？");
    assert.equal(fieldMappingCompatible(detail, { path: "formAnswers.customAnswer0", label: "是否有呼吸系统疾病？ / 如是，请告知详情" }), true);
    assert.equal(fieldMappingCompatible(detail, { path: "formAnswers.customAnswer1", label: "是否有色盲？ / 如是，请告知详情" }), false);
  });
});

test("scalar pages do not invent missing experience cards from model section declarations", async () => {
  const f = createFixture();
  const report = { mode: "read-only", origin: "http://127.0.0.1:4175", groups: [{ id: "g", label: "个人信息", entryCount: 1, source: "heading-range" }],
    fields: [{ ...f.fields[0], id: "field-1", groupId: "g", entrySource: "single" }], controls: [], summary: { truncated: false } };
  const current = await createPlanContext(report, f.ledger);
  const plan = await buildFillPlan(current, { snapshotId: current.snapshotId, groupMappings: [{ groupId: "g", sectionKeys: ["personal", "educations"] }],
    fieldMappings: [{ fieldId: "field-1", sourcePath: "personal.fullName" }], unresolved: [] });
  assert.equal(plan.summary.additionalEntries, 0); assert.equal(plan.summary.unresolvedEntries, 0);
});

test("a legacy region picker must select a real dictionary row and retain its hidden ID through audit", async () => {
  await withDOM('<section aria-label="个人信息"><ul><li><label>籍贯</label><input readonly class="Ajson ConstDictSingleSelect" constname="Areas"><input type="hidden" name="nativePlace"></li></ul></section>', async (doc) => {
    globalThis.BSGlobal = { TenantId: "123456" };
    const input = doc.querySelector('input[readonly]'), hidden = input.nextElementSibling;
    globalThis.jQuery = (el) => ({ basSelect(settings) {
      assert.equal(settings.valHost, hidden); assert.equal(settings.type, "radio");
      const panel = doc.createElement("div"); panel.className = "bas_select_wrap";
      panel.innerHTML = '<div class="bas_select_ctt"><li><div class="pr lst_item"><input type="radio" name="region" value="fictional-province"><label class="uf">虚构省</label><span class="uf"></span></div></li></div><div class="bas_select_buttons"><a class="bas_btn_canc">取消</a><a class="bas_btn_save">确定</a></div>';
      panel.querySelector('.pr .uf').onclick = () => { panel.querySelector('.bas_select_ctt').innerHTML = '<li><div class="lst_item"><input type="radio" name="region" value="fictional-city"><label>虚构市</label></div></li>'; };
      panel.querySelector('.bas_btn_save').onclick = () => { if (panel.querySelector('input:checked')) { el.value = "虚构市"; hidden.value = "fictional-city"; panel.remove(); } };
      panel.querySelector('.bas_btn_canc').onclick = () => panel.remove(); doc.body.append(panel);
    } }); globalThis.jQuery.fn = { basSelect() {} };
    installRealPageRuntime(); const runtime = __resumeAgentRuntime; const { report, token } = runtime.scan(location.href);
    const selection = { tabId: 17, url: location.href }, documentId = "fictional-picker-document";
    const environment = new ChromeFormEnvironment(selection, { documentId, tabs: { get: async () => ({ url: location.href }) },
      scripting: { executeScript: async (request) => [{ frameId: 0, documentId, result: await request.func(...request.args) }] } });
    environment.token = token;
    assert.equal((await environment.inspect(report.fields[0].id)).component, "legacy_area");
    assert.equal(report.fields[0].kind, "cascader");
    const pending = await runtime.fill({ token, fieldId: report.fields[0].id, sourcePath: "formAnswers.hometown", value: "虚构省/虚构市", regionParts: ["虚构省", "虚构市"] });
    assert.equal(pending.code, "LEGACY_PICKER_PENDING"); assert.equal(hidden.value, "");
    const completed = await environment.completeInputCommit(pending);
    assert.equal(completed.verified, true); assert.equal(hidden.value, "fictional-city");
    const target = [{ fieldId: report.fields[0].id, sourcePath: "formAnswers.hometown" }];
    assert.equal(runtime.audit({ token, targets: target })[0].verified, true);
    hidden.value = "wrong-id"; assert.equal(runtime.audit({ token, targets: target })[0].verified, false);
  });
});

test("an empty owned picker closes on failure without cancelling a different dialog or reporting a write", async () => {
  await withDOM('<input readonly class="ConstDictSingleSelect" constname="Areas"><input type="hidden" name="region">', async (doc) => {
    const input = doc.querySelector('input[readonly]'), ticket = crypto.randomUUID();
    input.setAttribute("data-resume-agent-picker", ticket);
    const owned = doc.createElement("div"); owned.className = "bas_select_wrap"; owned.setAttribute("data-resume-agent-picker-panel", ticket);
    owned.innerHTML = '<div class="bas_select_ctt"></div><div class="bas_select_buttons"><a class="bas_btn_canc">取消</a></div>';
    owned.querySelector("a").onclick = () => owned.remove(); doc.body.append(owned);
    const other = owned.cloneNode(true); other.setAttribute("data-resume-agent-picker-panel", crypto.randomUUID()); doc.body.append(other);
    const outcome = await completeLegacyPicker({ element: input, field: { component: "legacy_area" }, assertIdentity: () => true }, "", [],
      { expectedUrl: location.href, visible: () => true }, true);
    assert.equal(outcome.code, "SOURCE_UNAVAILABLE"); assert.equal(outcome.verified, false);
    assert.equal(owned.isConnected, false); assert.equal(other.isConnected, true); assert.equal(input.nextElementSibling.value, "");
  });
});

test("dictionary diagnosis contains only stage flags and a bounded count, without URL or tenant data", () => {
  const originals = ["location", "performance", "BSGlobal", "NewAjson"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://fictional-recruitment.example.test/resume" } });
    Object.defineProperty(globalThis, "performance", { configurable: true, value: { getEntriesByType: () => [
      { name: "https://const.italent.cn/api/setting/FICTIONAL_TENANT?token=FICTIONAL_SECRET" },
      { name: "https://const.italent.cn/resource/Areas-chs-1.0-100000.js" },
      { name: "https://unrelated.example.test/property/Areas/Pinyin.js" },
    ] } });
    globalThis.BSGlobal = { constSite: "//const.italent.cn" }; globalThis.NewAjson = [];
    const diagnosis = inspectAreaLoad(location.href);
    assert.deepEqual(diagnosis, { dictionarySettingsObserved: true, dictionaryAreasObserved: true,
      dictionaryPinyinObserved: false, dictionaryAvailable: false, areaContextReady: false, dictionaryRequestCount: 2 });
    assert.equal(JSON.stringify(diagnosis).includes("FICTIONAL"), false);
  } finally { for (const [name, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; }
});

test("a loaded area API without native page context cannot open a broken dictionary dialog", async () => {
  await withDOM('<section aria-label="个人信息"><li><label>籍贯</label><input readonly class="ConstDictSingleSelect" constname="Areas"><input type="hidden" name="nativePlace"></li></section>', async (doc) => {
    let calls = 0; globalThis.jQuery = () => ({ basSelect() { calls++; } }); globalThis.jQuery.fn = { basSelect() {} };
    globalThis.BSGlobal = { Register: {} };
    installRealPageRuntime(); const runtime = __resumeAgentRuntime, { report, token } = runtime.scan(location.href);
    const pending = await runtime.fill({ token, fieldId: report.fields[0].id, sourcePath: "formAnswers.hometown", value: "虚构省", regionParts: ["虚构省"] });
    const opened = openLegacyPicker(pending.pickerRequest, location.href);
    assert.equal(opened.code, "PICKER_CONTEXT_NOT_READY"); assert.equal(opened.opened, false); assert.equal(calls, 0);
    const completed = await runtime.finishPicker({ token, ticket: pending.pickerRequest.ticket, evidence: { opened: false, contextReady: false } });
    assert.equal(completed.code, "PICKER_CONTEXT_NOT_READY"); assert.equal(completed.verified, false);
    assert.equal(doc.querySelector("[data-resume-agent-picker]"), null); assert.equal(doc.querySelector("input[type=hidden]").value, "");
  });
});

test("profile changes during an interrupt invalidate old sources and the model replans after resume", async () => {
  const f = createFixture({ extraField: true }), regular = scriptedModel(); let paused = false;
  f.fields.at(-1).label = "职业规划";
  let ledger = Object.freeze({ ...f.ledger, profileRevision: "fictional-revision-1" });
  f.environment.observe = ({ verifiedMappings = [] } = {}) => createPlanContext({ mode: "read-only", origin: "http://127.0.0.1:4175",
    fields: structuredClone(f.fields), groups: structuredClone(f.groups), controls: [{ intent: "add-candidate", groupId: "group-2" }], summary: { truncated: false } }, ledger, { verifiedMappings });
  const basePlan = f.planner.planMappings, baseFill = f.environment.fill, baseAudit = f.environment.audit;
  f.planner.planMappings = async (context) => {
    const proposal = await basePlan(context);
    if (context.profileCatalog.some((fact) => fact.path === "jobPreferences.careerPlan")) {
      proposal.unresolved = []; proposal.groupMappings[0].sectionKeys.push("jobPreferences");
      proposal.fieldMappings.push({ fieldId: "field-extra", sourcePath: "jobPreferences.careerPlan" });
    }
    return proposal;
  };
  f.environment.fill = async (item, options) => {
    if (item.fieldId !== "field-extra") return baseFill(item, options);
    f.privateValues.set(item.fieldId, ledger.getValue(item.sourcePath)); f.fields.at(-1).hasValue = true;
    return { code: "VERIFIED", verified: true };
  };
  f.environment.audit = async (targets) => (await baseAudit(targets.filter((item) => item.fieldId !== "field-extra")))
    .concat(targets.filter((item) => item.fieldId === "field-extra").map((item) => ({ ...item, code: "VERIFIED", verified: f.privateValues.get(item.fieldId) === ledger.getValue(item.sourcePath) })));
  const events = [];
  const agent = createResumeAgent({ ...f, onEvent: (event) => events.push(event), model: { async decide(context) {
    if (context.receipts.length && !paused && context.auditRequired) return { evaluation: "uncertain", nextGoal: "暂停前复核虚构资料",
      action: { tool: "audit", snapshotId: context.snapshotId } };
    if (context.receipts.length && !paused) { paused = true; return { evaluation: "uncertain", nextGoal: "补充虚构资料",
      action: { tool: "request_review", snapshotId: context.snapshotId, reason: "missing_data" } }; }
    return regular.decide(context);
  } } });
  const first = await agent.run(); assert.equal(first.status, "waiting_review");
  const updated = structuredClone(labProfile); updated.profile.jobPreferences = { careerPlan: "FICTIONAL_NEW_PLAN" };
  ledger = ledgerFromProfile({ ...importProfile(updated).stored, revision: "fictional-revision-2" });
  const result = await agent.resume();
  assert.ok(events.some((event) => event.code === "PROFILE_CHANGED"));
  assert.equal(result.result.agentWrittenFields, 7);
  assert.equal(f.privateValues.get("field-extra"), "FICTIONAL_NEW_PLAN");
  assert.ok(regular.contexts.filter((context) => !context.planAvailable).length >= 2);
  assert.equal(JSON.stringify(regular.contexts).includes("FICTIONAL_NEW_PLAN"), false);
  await agent.dispose();
});

test("readonly calendars are actionable but a month without an approved day is not fabricated", async () => {
  await withDOM('<section aria-label="个人信息"><li><label>预计毕业日期</label><input readonly class="Wdate"></li></section>', async () => {
    const report = readFormStructure(location.href, true); assert.equal(report.fields[0].kind, "date");
    const result = await fillBoundField({ token: __resumeAgentBindings.token, fieldId: report.fields[0].id, sourcePath: "formAnswers.expectedGraduationDate", value: "2027-06", monthStartDay: false });
    assert.equal(result.code, "DATE_PRECISION_INCOMPATIBLE"); assert.equal(result.verified, false);
  });
});

test("a bound readonly calendar chooses a day in the verified view and audits its committed value", async () => {
  await withDOM('<section aria-label="个人信息"><li><label>预计毕业日期</label><input readonly class="Wdate" name="graduation"></li></section>', async (doc) => {
    globalThis.WdatePicker = ({ el, startDate, alwaysUseStartDate }) => {
      assert.equal(alwaysUseStartDate, true); assert.equal(startDate, "2027-06-12");
      const frame = doc.createElement("iframe"); doc.body.append(frame);
      frame.contentDocument.body.innerHTML = '<div class="WdateDiv"><div class="dpTitle"><input class="yminput" value="2027"><input class="yminput" value="6"></div><table class="WdayTable"><tbody><tr><td class="Wday">12</td></tr></tbody></table></div>';
      frame.contentDocument.querySelector("td").onclick = () => { el.value = "2027-06-12"; frame.remove(); };
    };
    installRealPageRuntime(); const runtime = __resumeAgentRuntime, { report, token } = runtime.scan(location.href);
    const pending = await runtime.fill({ token, fieldId: report.fields[0].id, sourcePath: "formAnswers.expectedGraduationDate", value: "2027-06-12" });
    const result = await runtime.finishPicker({ token, ticket: pending.pickerRequest.ticket, evidence: openLegacyPicker(pending.pickerRequest, location.href) });
    assert.equal(result.verified, true); assert.equal(result.diagnostic.pathMatched, true);
    assert.equal(runtime.audit({ token, targets: [{ fieldId: report.fields[0].id, sourcePath: "formAnswers.expectedGraduationDate" }] })[0].verified, true);
  });
});

test("the LLM can choose an inspection and receives validated feedback before its next action", async () => {
  const f = createFixture(); const base = scriptedModel(); let inspected = false, observedFeedback = false;
  f.environment.inspect = async (fieldId) => ({ fieldId, code: "CONTROL_INSPECTED", component: "native_or_custom", readOnly: false,
    optionLabels: ["FICTIONAL_OPTION"], documentReady: true, areaApiAvailable: false, calendarApiAvailable: false });
  const agent = createResumeAgent({ ...f, model: { async decide(context) {
    if (context.lastResult?.code === "CONTROL_INSPECTED") observedFeedback = context.inspections[0].optionLabels[0] === "FICTIONAL_OPTION";
    if (!inspected) { inspected = true; return { evaluation: "not_applicable", nextGoal: "检查虚构控件", action: { tool: "inspect_field", fieldId: "field-1", snapshotId: context.snapshotId } }; }
    return base.decide(context);
  } } });
  const result = await agent.run(); assert.equal(observedFeedback, true); assert.ok(result.result.agentWrittenFields > 0);
  const coverage = fieldCoverage(await f.environment.observe(), null, []); assert.ok(coverage.every((field) => !Object.hasOwn(field, "value")));
  await agent.dispose();
});

test("an audit prerequisite preserves the model's review intent without automatically choosing its next tool", async () => {
  const f = createFixture({ extraField: true }), regular = scriptedModel(); let requested = false, sawIntent = false;
  const agent = createResumeAgent({ ...f, model: { async decide(context) {
    if (context.reviewIntent) {
      sawIntent = context.reviewIntent.reason === "missing_data";
      return { evaluation: "uncertain", nextGoal: "先复核，再由模型重新请求补充",
        action: { tool: context.auditRequired ? "audit" : "request_review", ...(context.auditRequired ? {} : { reason: "missing_data" }), snapshotId: context.snapshotId } };
    }
    if (context.receipts.some((receipt) => receipt.verified) && !requested) { requested = true;
      return { evaluation: "uncertain", nextGoal: "等待缺失资料", action: { tool: "request_review", reason: "missing_data", snapshotId: context.snapshotId } };
    }
    return regular.decide(context);
  } } });
  const paused = await agent.run(); assert.equal(paused.status, "waiting_review"); assert.equal(paused.result.auditCurrent, true); assert.equal(sawIntent, true);
  const resumed = await agent.resume(); assert.ok(resumed.result.agentWrittenFields > 0);
  assert.ok(regular.contexts.some((context) => context.lastResult?.code === "USER_RESUMED" && context.reviewIntent === null));
  await agent.dispose();
});
