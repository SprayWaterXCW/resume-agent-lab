import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createLabServer } from "../service/server.mjs";
import { createFixture, scriptedModel } from "./fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("independent local setup starts blank, returns no key, and checks host/token/origin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resume-agent-lab-service-"));
  const service = await createLabServer({ root, port: 0, dataDirectory: directory });
  const origin = `http://127.0.0.1:${service.port}`;
  try {
    const status = await (await fetch(origin + "/api/status")).json(); assert.equal(status.modelConfigured, false);
    assert.equal(status.agentRuntime, "langgraph_model_directed");
    assert.equal((await fetch(origin + "/api/settings")).status, 403);
    assert.equal((await fetch(origin + "/api/settings", { headers: { "X-Lab-Token": "a".repeat(63) } })).status, 403);
    const html = await (await fetch(origin)).text(); assert.ok(html.includes(service.csrf));
    const headers = { "X-Lab-Token": service.csrf, Origin: origin, "Content-Type": "application/json" };
    const config = { baseUrl: "https://api.example.test/v1", model: "fictional-model", apiKey: "FICTIONAL_KEY" };
    const saved = await fetch(origin + "/api/settings", { method: "POST", headers, body: JSON.stringify(config) });
    assert.equal(saved.status, 200); assert.equal((await saved.text()).includes("FICTIONAL_KEY"), false);
    const read = await (await fetch(origin + "/api/settings", { headers })).json(); assert.equal(read.hasApiKey, true); assert.equal(Object.hasOwn(read, "apiKey"), false);
    assert.equal((await fetch(origin + "/api/settings", { method: "POST", headers: { ...headers, Origin: "https://foreign.example" }, body: JSON.stringify(config) })).status, 403);
    assert.equal((await fetch(origin + "/.local/config.json")).status, 403);
    assert.notEqual(service.extensionId, "lmgllncoafdghpeaoephgojaifocofbo");
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("WebSocket bridge executes a complete LangGraph run via value-free reverse RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resume-agent-lab-bridge-")); const fixture = createFixture({ failFirstMajor: true });
  const service = await createLabServer({ root, port: 0, dataDirectory: directory, modelsFactory: async () => ({ planner: fixture.planner, model: scriptedModel({ addFirst: true }) }) });
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/agent`, { origin: `chrome-extension://${service.extensionId}` });
  const runId = crypto.randomUUID(), events = [], transported = [];
  try {
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const complete = new Promise((resolve, reject) => {
      socket.on("message", async (raw) => {
        const message = JSON.parse(raw.toString()); transported.push(message);
        if (message.type === "event") events.push(message.event);
        if (message.type === "error") reject(new Error(message.code));
        if (message.type === "result") resolve(message);
        if (message.type !== "tool") return;
        let result;
        if (message.method === "observe") result = await fixture.environment.observe(message.args);
        if (message.method === "fill") result = await fixture.environment.fill(message.args.item, message.args);
        if (message.method === "add") result = await fixture.environment.add(message.args.groupId);
        if (message.method === "audit") result = await fixture.environment.audit(message.args.targets);
        if (message.method === "wait") result = await fixture.environment.wait(message.args.milliseconds);
        socket.send(JSON.stringify({ type: "tool_result", runId, id: message.id, ok: true, result }));
      });
    });
    socket.send(JSON.stringify({ type: "start", runId }));
    const timeout = setTimeout(() => socket.terminate(), 10_000);
    let result; try { result = await complete; } finally { clearTimeout(timeout); }
    assert.equal(result.result.agentWrittenFields, 6); assert.equal(result.result.agentAddedCards, 1);
    assert.ok(events.some((e) => e.tool === "retry_field")); assert.ok(events.some((e) => e.code === "STRUCTURE_CHANGED"));
    const serialized = JSON.stringify(transported);
    for (const entry of fixture.ledger.publicEntries) assert.equal(serialized.includes(fixture.ledger.getValue(entry.path)), false);
    const selected = events.filter((e) => e.code === "MODEL_SELECTED_TOOL");
    assert.ok(selected.length >= 10); assert.equal(selected[1].tool, "add_entry");
  } finally { socket.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("WebSocket bridge rejects the stable plugin origin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resume-agent-lab-origin-"));
  const service = await createLabServer({ root, port: 0, dataDirectory: directory });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${service.port}/agent`, { origin: "chrome-extension://lmgllncoafdghpeaoephgojaifocofbo" });
    const result = await new Promise((resolve) => { socket.once("open", () => resolve("open")); socket.once("error", () => resolve("denied")); });
    assert.equal(result, "denied"); socket.terminate();
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("first-observation failures preserve sanitized Chrome diagnostics in the service result and record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resume-agent-lab-diagnostic-")), records = [];
  const service = await createLabServer({ root, port: 0, dataDirectory: directory, modelsFactory: async () => ({ model: {}, planner: {} }),
    onRecord: record => records.push(record) });
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/agent`, { origin: `chrome-extension://${service.extensionId}` });
  const runId = crypto.randomUUID();
  const diagnostic = { version: 1, method: "observe", stage: "context_build", errorType: "FillPlanError", observation: {
    version: 1, area: "profile_catalog", issueCount: 1, issues: [{ code: "invalid_value", path: [3, "derivation"] }] } };
  try {
    await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
    const complete = new Promise(resolve=>socket.on("message",raw=>{
      const message = JSON.parse(raw.toString());
      if (message.type === "tool") socket.send(JSON.stringify({ type: "tool_result", runId, id: message.id, ok: false,
        code: "PLAN_CONTEXT_INVALID", toolDiagnostic: diagnostic, rawMessage: "FICTIONAL_PRIVATE_ERROR" }));
      if (message.type === "error") resolve(message);
    }));
    socket.send(JSON.stringify({ type: "start", runId }));
    const timeout = setTimeout(()=>socket.terminate(),5000);
    let result; try { result = await complete; } finally { clearTimeout(timeout); }
    assert.equal(result.code, "PLAN_CONTEXT_INVALID"); assert.deepEqual(result.toolDiagnostic, diagnostic);
    assert.deepEqual(records[0].toolDiagnostic, diagnostic);
    assert.equal(JSON.stringify([result,records]).includes("FICTIONAL_PRIVATE_ERROR"),false);
  } finally { socket.close(); await service.close(); await rm(directory,{recursive:true,force:true}); }
});
