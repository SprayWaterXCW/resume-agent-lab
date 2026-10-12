import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFormStructure } from "../agent-extension/src/page-scan.js";
import { fillBoundField } from "../agent-extension/src/real-page.js";
import { fieldMappingCompatible } from "../src/core/field-semantics.js";
import { createPlanContext, buildFillPlan } from "../src/core/fill-plan.js";
import { fieldKey } from "../src/agent/policy.mjs";

test("native radio questions map once, keep options private, and commit only the matching option", async () => {
  const dom = new JSDOM(`<section aria-label="基本信息"><form>
    <div><span>性别</span><div><input type="radio" name="gender" value="1"><label>男</label><input type="radio" name="gender" value="2"><label>女</label></div></div>
    <div><span>是否接受轮班？</span><div><input type="radio" name="shift" value="1"><span>是</span><input type="radio" name="shift" value="0"><span>否</span></div></div>
    <label>手机号<input value="FICTIONAL_PRIVATE_PHONE"></label></form></section>`, { url: "https://recruitment.example.test/resume" });
  const names = ["document", "location", "getComputedStyle", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Event"];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const oldBindings = globalThis.__resumeAgentBindings;
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[name] });
  dom.window.Element.prototype.getClientRects = function () { return [{}]; };
  try {
    const report = readFormStructure(dom.window.location.href, true);
    const radios = report.fields.filter((field) => field.kind === "radio");
    assert.deepEqual(radios.map((field) => [field.label, field.choiceOptions]), [["性别", ["男", "女"]], ["是否接受轮班？", ["是", "否"]]]);
    const context = await createPlanContext(report, { profileKind: "user_import", publicFacts: [
      { path: "personal.gender", label: "性别", sectionKey: "personal", entryIndex: 0, status: "verified", evidenceCount: 1 },
      { path: "jobPreferences.acceptShiftWork", label: "是否接受轮班？", sectionKey: "jobPreferences", entryIndex: 0, status: "verified", evidenceCount: 1 },
    ] });
    assert.ok(radios.every((field) => fieldKey(context, field.id)));
    const plan = await buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [], fieldMappings: [
      { fieldId: radios[0].id, sourcePath: "personal.gender" },
      { fieldId: radios[1].id, sourcePath: "jobPreferences.acceptShiftWork" },
    ], unresolved: [] });
    assert.equal(plan.items.filter((item) => item.sourcePath).length, 2);
    assert.equal(JSON.stringify(report).includes("FICTIONAL_PRIVATE_PHONE"), false);
    const token = globalThis.__resumeAgentBindings.token;
    const result = await fillBoundField({ token, fieldId: radios[0].id, sourcePath: "personal.gender", value: "女" });
    assert.equal(result.verified, true);
    assert.equal(dom.window.document.querySelectorAll('input[name=gender]')[1].checked, true);
    assert.ok([...dom.window.document.querySelectorAll('input[name=shift]')].every((input) => !input.checked));
    dom.window.document.querySelectorAll('input[name=gender]')[1].nextElementSibling.textContent = "变化后的选项";
    assert.equal(globalThis.__resumeAgentBindings.fields.get(radios[0].id).assertIdentity(), false);
  } finally {
    for (const [name, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];
    globalThis.__resumeAgentBindings = oldBindings; dom.window.close();
  }
});

test("biography sources cannot be borrowed for unrelated medical follow-up questions", () => {
  const fact = { path: "personal.summary", label: "个人简介", sectionKey: "personal" };
  assert.equal(fieldMappingCompatible({ label: "个人简介", kind: "textarea" }, fact), true);
  assert.equal(fieldMappingCompatible({ label: "如您有过精神疾病史，请告知服用药物的历史详情和现在的情况", kind: "textarea" }, fact), false);
  assert.equal(fieldMappingCompatible({ label: "请告知详情", kind: "textarea" }, fact), false);
});

test("latest education study-mode projections retain their source evidence", () => {
  const field = { label: "学习形式", kind: "select" };
  const fact = { path: "formAnswers.educationsLatestStudyMode", sectionKey: "formAnswers", derivation: "latest_record", derivedFrom: ["educations.1.studyMode"] };
  assert.equal(fieldMappingCompatible(field, fact, "个人信息"), true);
  assert.equal(fieldMappingCompatible(field, { ...fact, derivedFrom: ["educations.1.degree"] }, "个人信息"), false);
  assert.equal(fieldMappingCompatible(field, { ...fact, derivation: undefined }, "个人信息"), false);
});
