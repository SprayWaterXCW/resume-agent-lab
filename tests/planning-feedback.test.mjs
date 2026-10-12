import test from "node:test";
import assert from "node:assert/strict";
import { createResumeAgent } from "../src/agent/graph.mjs";
import { planResponseDiagnostic } from "../src/core/plan-response-diagnostics.js";
import { createFixture, scriptedModel } from "./fixture.mjs";

test("planning retains safe format diagnostics and previous failures for model-led repair", async () => {
  const fixture = createFixture(), model = scriptedModel(), events = [], received = [];
  const responseDiagnostic = planResponseDiagnostic({ stage: "tool_call_count", payload: { choices: [{
    finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "propose_form_mapping", arguments: "{}" } },
      { type: "function", function: { name: "propose_form_mapping", arguments: "{}" } }] } }] },
    fieldCount: 4, catalogCount: fixture.ledger.publicFacts.length, toolSchemaChars: 123 });
  let calls = 0;
  const planner = { async planMappings(context, feedback) {
    received.push(structuredClone(feedback)); calls++;
    if (calls === 1) throw Object.assign(new Error("PLAN_MODEL_RESPONSE_INVALID"), { code: "PLAN_MODEL_RESPONSE_INVALID", responseDiagnostic });
    if (calls === 2) throw Object.assign(new Error("PLAN_UNKNOWN_REFERENCE"), { code: "PLAN_UNKNOWN_REFERENCE",
      diagnostic: { violation: "unknown_source", fieldIds: ["field-1"], unknownReferenceCount: 1 } });
    return fixture.planner.planMappings(context);
  } };
  const agent = createResumeAgent({ ...fixture, planner, model, onEvent: (event) => events.push(event) });
  try {
    const result = await agent.run(); assert.equal(result.result.agentWrittenFields, 6);
    assert.deepEqual(received[1].responseDiagnostic, responseDiagnostic);
    assert.deepEqual(received[2].previousFailures[0].responseDiagnostic, responseDiagnostic);
    assert.equal(received[2].diagnostic.violation, "unknown_source");
    assert.ok(events.some((event) => event.responseDiagnostic?.stage === "tool_call_count"));
    const repair = model.contexts.find((context) => context.planFailure?.previousFailures?.length);
    assert.ok(repair);
    for (const entry of fixture.ledger.publicEntries) assert.equal(JSON.stringify({ received, events }).includes(fixture.ledger.getValue(entry.path)), false);
  } finally { await agent.dispose(); }
});

test("without a usable plan the summary reports pending planning fields instead of zero", async () => {
  const fixture = createFixture();
  const model = { async decide(context) { return { evaluation: "uncertain", nextGoal: "暂停供人工核对",
    action: { tool: "request_review", snapshotId: context.snapshotId, reason: "user_check" } }; } };
  const agent = createResumeAgent({ ...fixture, model });
  try {
    const result = await agent.run(); assert.equal(result.result.planAvailable, false);
    assert.equal(result.result.unplannedCount, 4); assert.equal(result.result.agentWrittenFields, 0);
  } finally { await agent.dispose(); }
});

test("different planning failures remain repairable while an identical repeated failure stops", async () => {
  for (const changingFailure of [true, false]) {
    const fixture = createFixture(), model = scriptedModel(); let calls = 0;
    const planner = { async planMappings(context) {
      if (calls++ < 3) throw Object.assign(new Error("PLAN_SEMANTIC_MISMATCH"), { code: "PLAN_SEMANTIC_MISMATCH",
        diagnostic: { violation: "incompatible_semantics", fieldIds: [changingFailure ? `field-${calls}` : "field-1"] } });
      return fixture.planner.planMappings(context);
    } };
    const agent = createResumeAgent({ ...fixture, planner, model });
    try {
      const result = await agent.run();
      assert.equal(result.result.agentWrittenFields, changingFailure ? 6 : 0);
      assert.equal(result.result.code, changingFailure ? "MODEL_FINISHED" : "REPEATED_ACTION_LIMIT");
      if (!changingFailure) assert.equal(calls, 3);
    } finally { await agent.dispose(); }
  }
});
