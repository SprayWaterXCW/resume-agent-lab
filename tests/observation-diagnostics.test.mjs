import test from "node:test";
import assert from "node:assert/strict";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { createPlanContext, validatePlanContext, buildFillPlan } from "../src/core/fill-plan.js";
import { observationDiagnostic, toolFailureDiagnostic, toolFailureDiagnosticSchema } from "../src/core/observation-diagnostics.js";
import { createResumeAgent } from "../src/agent/graph.mjs";

const report = () => ({ mode: "read-only", origin: "https://fictional.example.test", summary: { truncated: false },
  groups: [{ id: "group-1", label: "基本信息", entryCount: 1 }], controls: [],
  fields: [{ id: "field-1", groupId: "group-1", entryIndex: 0, label: "期望年薪（税前）", labelSource: "label", kind: "text",
    required: false, disabled: false, readOnly: false, hasValue: false, valueExcluded: false }] });

test("configured annual projections cross the serialized observation contract and reach model decisions", async () => {
  for (const salary of [{ expectedAnnualSalary: "180000～240000" }, { expectedSalary: "20万元/年" },
    { expectedSalary: "20万", expectedSalaryPeriod: "年薪" }]) {
    const ledger = ledgerFromProfile(importProfile({ jobPreferences: salary }).stored);
    const context = await createPlanContext(report(), ledger);
    const transported = await validatePlanContext(JSON.parse(JSON.stringify(context)));
    assert.equal(transported.profileCatalog.find(f=>f.path === "formAnswers.expectedAnnualSalary").derivation, "salary_annual");
    const plan = await buildFillPlan(transported, { snapshotId: transported.snapshotId,
      groupMappings: [{ groupId: "group-1", sectionKeys: ["jobPreferences", "formAnswers"] }],
      fieldMappings: [{ fieldId: "field-1", sourcePath: "formAnswers.expectedAnnualSalary" }], unresolved: [] });
    assert.equal(plan.items[0].sourcePath, "formAnswers.expectedAnnualSalary");
    let decisions = 0;
    const agent = createResumeAgent({ environment: { observe: async()=>transported }, planner: {}, model: {
      async decide(state) { decisions++; return { evaluation: "uncertain", nextGoal: "虚构场景暂停核对", action: {
        tool: "request_review", snapshotId: state.snapshotId, reason: "user_check" } }; }
    } });
    try { assert.equal((await agent.run()).status, "waiting_review"); assert.equal(decisions, 1); }
    finally { await agent.dispose(); }
    // Public labels describe annual/monthly periods; the private amount must not cross the bridge.
    for (const value of Object.values(salary).filter(value=>/\d/.test(value))) assert.equal(JSON.stringify(transported).includes(value), false);
  }
});

test("invalid catalog metadata reports its indexed schema location without raw exception or private input", async () => {
  const ledger = ledgerFromProfile(importProfile({ personal: { fullName: "FICTIONAL_PRIVATE_PERSON" } }).stored);
  const incompatible = { ...ledger, publicFacts: ledger.publicFacts.map(f=>({ ...f, derivation: "FICTIONAL_PRIVATE_UNSUPPORTED_VALUE" })) };
  await assert.rejects(createPlanContext(report(), incompatible), error => {
    assert.equal(error.code, "PLAN_CONTEXT_INVALID");
    assert.equal(error.observationDiagnostic.area, "profile_catalog");
    assert.deepEqual(error.observationDiagnostic.issues[0].path, [0, "derivation"]);
    assert.equal(error.observationDiagnostic.issues[0].code, "invalid_value");
    assert.equal(JSON.stringify(error).includes("FICTIONAL_PRIVATE"), false);
    const diagnostic = toolFailureDiagnostic(error, "observe", "context_build");
    assert.equal(diagnostic.errorType, "FillPlanError"); assert.ok(toolFailureDiagnosticSchema.safeParse(diagnostic).success);
    return true;
  });
});

test("page contract errors retain useful bounds and never store an overlong field label", async () => {
  const ledger = ledgerFromProfile(importProfile({ personal: { fullName: "Fictional Applicant" } }).stored);
  const page = report(); page.fields[0].label = "FICTIONAL_PRIVATE_LABEL" + "x".repeat(200);
  await assert.rejects(createPlanContext(page, ledger), error => {
    assert.equal(error.observationDiagnostic.area, "page");
    assert.deepEqual(error.observationDiagnostic.issues[0].path, ["fields", 0, "label"]);
    assert.equal(error.observationDiagnostic.issues[0].maximum, 180);
    assert.equal(JSON.stringify(error).includes("FICTIONAL_PRIVATE_LABEL"), false); return true;
  });
});

test("failure diagnostics discard free text, unknown schema keys, enum values and arbitrary stages", () => {
  const observation = observationDiagnostic("context", { issues: [{ code: "invalid_value", path: ["FICTIONAL_SECRET_KEY", 3, "derivation"],
    message: "FICTIONAL_SECRET_MESSAGE", input: "FICTIONAL_SECRET_INPUT", values: ["FICTIONAL_SECRET_ENUM"] }] });
  assert.deepEqual(observation.issues[0].path, ["unknown_key", 3, "derivation"]);
  const diagnostic = toolFailureDiagnostic(Object.assign(new TypeError("FICTIONAL_SECRET_MESSAGE"), { observationDiagnostic: observation }),
    "FICTIONAL_SECRET_METHOD", "FICTIONAL_SECRET_STAGE");
  assert.equal(diagnostic.method, "unknown"); assert.equal(diagnostic.stage, "unknown");
  assert.equal(diagnostic.errorType, "TypeError"); assert.equal(JSON.stringify(diagnostic).includes("FICTIONAL_SECRET"), false);
  assert.equal(toolFailureDiagnosticSchema.safeParse({ ...diagnostic, rawMessage: "FICTIONAL_SECRET_MESSAGE" }).success, false);
});
