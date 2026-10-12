import test from "node:test";
import assert from "node:assert/strict";
import { createResumeAgent } from "../src/agent/graph.mjs";
import { decodeDecision } from "../src/agent/tools.mjs";
import { AgentActionModel } from "../src/agent/model.mjs";
import { createFixture, scriptedModel } from "./fixture.mjs";

test("real LangGraph follows different model-selected fill/add orders", async () => {
  const sequences = [];
  for (const addFirst of [false, true]) {
    const fixture = createFixture(), model = scriptedModel({ addFirst });
    const agent = createResumeAgent({ ...fixture, model });
    const result = await agent.run();
    assert.equal(result.result.agentWrittenFields, 6); assert.equal(result.result.agentAddedCards, 1);
    assert.equal(result.result.remainingBlankFields, 0); assert.equal(result.result.serverAcceptance, "not_checked");
    sequences.push(fixture.calls.filter((c) => ["fill_field", "add_entry"].includes(c.tool)).map((c) => c.tool));
    assert.ok(agent.graph.nodes.decide); assert.ok(agent.graph.nodes.policy);
    await agent.dispose();
  }
  assert.equal(sequences[0][0], "fill_field"); assert.equal(sequences[1][0], "add_entry");
  assert.notDeepEqual(sequences[0], sequences[1]);
});

test("a failed tool result reaches the next decision and the model chooses alternate retry", async () => {
  const fixture = createFixture({ failFirstMajor: true }), model = scriptedModel();
  const agent = createResumeAgent({ ...fixture, model });
  const result = await agent.run();
  assert.equal(result.result.agentWrittenFields, 6);
  assert.equal(result.result.expectedFields, 6); assert.equal(result.result.writeAttempts, 7);
  const failureContext = model.contexts.find((c) => c.lastResult?.code === "READBACK_MISMATCH");
  assert.ok(failureContext); assert.equal(failureContext.retryableFields.length, 1);
  assert.equal(fixture.calls.filter((c) => c.tool === "retry_field").length, 1);
  const checkpoints = [];
  for await (const state of agent.graph.getStateHistory(agent.config)) checkpoints.push(state.values);
  assert.ok(checkpoints.length > 10);
  const encoded = JSON.stringify({ contexts: model.contexts, checkpoints });
  for (const value of fixture.ledger.publicEntries.map((entry) => fixture.ledger.getValue(entry.path)))
    assert.equal(encoded.includes(value), false, "private values must not enter the model or checkpoints");
  await agent.dispose();
});

test("submission, arbitrary selectors and invented tools never reach the executor", async () => {
  const fixture = createFixture();
  const model = { async decide(context) { return { evaluation: "not_applicable", nextGoal: "恶意操作", action: {
    tool: "click", snapshotId: context.snapshotId, selector: "button[type=submit]" } }; } };
  const agent = createResumeAgent({ ...fixture, model }); const result = await agent.run();
  assert.equal(result.result.agentWrittenFields, 0); assert.equal(result.result.code, "AGENT_DECISION_INVALID");
  assert.ok(fixture.calls.every((c) => c.tool === "observe")); await agent.dispose();
});

test("invented source paths are rejected, with evidence returned for a new decision", async () => {
  const fixture = createFixture(), regular = scriptedModel(); let tried = false;
  const model = { async decide(context) {
    if (context.planAvailable && !tried) { tried = true; return { evaluation: "uncertain", nextGoal: "非法来源测试",
      action: { tool: "fill_field", snapshotId: context.snapshotId, fieldId: "field-1", sourcePath: "personal.invented" } }; }
    return regular.decide(context);
  } };
  const agent = createResumeAgent({ ...fixture, model }); const result = await agent.run();
  assert.equal(result.result.agentWrittenFields, 6);
  assert.ok(regular.contexts.some((c) => c.lastResult?.code === "UNVALIDATED_FILL_TARGET"));
  assert.ok(!fixture.calls.some((c) => c.sourcePath === "personal.invented")); await agent.dispose();
});

test("page changes during model latency cancel the stale action before any write", async () => {
  const fixture = createFixture(), regular = scriptedModel(); let changed = false;
  const model = { async decide(context) {
    const decision = await regular.decide(context);
    if (decision.action.tool === "fill_field" && !changed) { changed = true;
      fixture.fields.find((f) => f.id === decision.action.fieldId).label = "未配置的新问题";
    }
    return decision;
  } };
  const agent = createResumeAgent({ ...fixture, model }); const result = await agent.run();
  assert.ok(regular.contexts.some((c) => c.lastResult?.code === "STALE_OBSERVATION"));
  assert.ok(!fixture.calls.some((c) => c.tool === "fill_field" && c.fieldId === "field-1"));
  assert.equal(result.result.agentWrittenFields, 5); assert.equal(result.result.unplannedCount, 1);
  await agent.dispose();
});

test("final audit retracts a lost write and missing profile fields remain visible", async () => {
  const fixture = createFixture({ dropOnAudit: true, extraField: true }), model = scriptedModel();
  const agent = createResumeAgent({ ...fixture, model }); const result = await agent.run();
  assert.ok(result.result.agentWrittenFields < 6); assert.ok(result.result.unresolvedCount > 0);
  assert.equal(result.result.unplannedCount, 1); assert.ok(result.result.remainingBlankFields >= 2);
  assert.equal(result.status, "partial"); assert.equal(result.result.serverAcceptance, "not_checked"); await agent.dispose();
});

test("LangGraph interrupt pauses writes and Command resumes with a fresh observation", async () => {
  const fixture = createFixture(), regular = scriptedModel(); let paused = false;
  const model = { async decide(context) {
    if (context.planAvailable && !paused) { paused = true; return { evaluation: "uncertain", nextGoal: "等待用户核对",
      action: { tool: "request_review", snapshotId: context.snapshotId, reason: "user_check" } }; }
    return regular.decide(context);
  } };
  const agent = createResumeAgent({ ...fixture, model });
  const first = await agent.run(); assert.equal(first.status, "waiting_review"); assert.equal(first.result.agentWrittenFields, 0);
  const checkpoint = await agent.graph.getState(agent.config); assert.deepEqual(checkpoint.next, ["human_review"]);
  const callsBefore = fixture.calls.length;
  const resumed = await agent.resume(); assert.equal(resumed.result.agentWrittenFields, 6);
  assert.equal(fixture.calls[callsBefore].tool, "observe");
  assert.ok(regular.contexts.some((c) => c.lastResult?.code === "USER_RESUMED")); await agent.dispose();
});

test("step budgets and stop signals never substitute a fixed filling policy", async () => {
  const fixture = createFixture();
  const model = { async decide(context) { return { evaluation: "uncertain", nextGoal: "短暂等待", action: { tool: "wait", milliseconds: 100, snapshotId: context.snapshotId } }; } };
  const agent = createResumeAgent({ ...fixture, model, limits: { maxSteps: 2 } });
  const result = await agent.run(); assert.equal(result.result.code, "STEP_BUDGET_EXHAUSTED");
  assert.equal(result.result.agentWrittenFields, 0); assert.equal(fixture.calls.filter((c) => c.tool === "wait").length, 2); await agent.dispose();
  const controller = new AbortController(); controller.abort();
  const stopped = createResumeAgent({ ...createFixture(), model, signal: controller.signal });
  assert.equal((await stopped.run()).status, "stopped"); await stopped.dispose();
});

test("structured tool decoding defers model batches and rejects extra args or unsafe calls", () => {
  const call = (name, args) => ({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  const args = { snapshotId: "a".repeat(64), evaluation: "uncertain", nextGoal: "等待", milliseconds: 100 };
  assert.equal(decodeDecision(call("wait", args)).action.tool, "wait");
  assert.throws(() => decodeDecision(call("submit", args)), /AGENT_TOOL_NOT_ALLOWED/);
  assert.throws(() => decodeDecision(call("wait", { ...args, value: "invented" })), /AGENT_DECISION_INVALID/);
  const parallel = call("wait", args); parallel.choices[0].message.tool_calls.push(parallel.choices[0].message.tool_calls[0]);
  assert.equal(decodeDecision(parallel).action.tool, "wait"); assert.equal(decodeDecision(parallel).deferredActions.length, 1);
  parallel.choices[0].message.tool_calls[1] = call("submit", args).choices[0].message.tool_calls[0];
  assert.throws(() => decodeDecision(parallel), /AGENT_TOOL_NOT_ALLOWED/);
});

test("actual HTTP adapter requests model tools, sanitizes failures and keeps keys out of the context", async () => {
  let posted;
  const model = new AgentActionModel({ baseUrl: "http://127.0.0.1:49999/v1", model: "fictional-model", apiKey: "FICTIONAL_SECRET",
    fetchImpl: async (url, options) => { posted = options; return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "wait",
      arguments: JSON.stringify({ snapshotId: "a".repeat(64), milliseconds: 100, evaluation: "uncertain", nextGoal: "等待" }) } }] } }] })); } });
  assert.equal((await model.decide({ snapshotId: "a".repeat(64) })).action.tool, "wait");
  assert.equal(posted.headers.Authorization, "Bearer FICTIONAL_SECRET"); assert.equal(posted.redirect, "error");
  assert.equal(posted.body.includes("FICTIONAL_SECRET"), false); assert.equal(JSON.parse(posted.body).tools.length, 9);
  model.fetchImpl = async () => new Response("FICTIONAL_SECRET raw error", { status: 401 });
  await assert.rejects(model.decide({}), (e) => e.code === "MODEL_HTTP_ERROR" && e.status === 401 && !JSON.stringify(e).includes("FICTIONAL_SECRET"));
});
