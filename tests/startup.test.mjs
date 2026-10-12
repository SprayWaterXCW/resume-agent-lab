import test from "node:test";
import assert from "node:assert/strict";
import { startupStage, openAgentSocket } from "../agent-extension/src/startup-stage.js";
import { bindFormDocument, ChromeFormEnvironment } from "../agent-extension/src/real-tab.js";

test("a document stuck loading can bind and scan without waiting for document_idle", async () => {
  const selection = { tabId: 17, url: "https://recruitment.example.test/resume" };
  const documentId = "fictional-original-document", calls = [], stages = [];
  const tabs = { get: async () => ({ id: selection.tabId, url: selection.url }) };
  const report = { mode: "read-only", fields: [], groups: [], controls: [] };
  const scripting = { executeScript: async (request) => {
    calls.push(request);
    if (!request.injectImmediately) return new Promise(() => {});
    return [{ frameId: 0, documentId, result: request.args?.[0] === "scan" ? { token: "fictional", report }
      : request.files ? undefined : { matched: true, readyState: "loading" } }];
  } };
  const bound = await startupStage(() => bindFormDocument(selection, { tabs, scripting, onStage: (stage) => stages.push(stage) }),
    { timeoutMs: 100, timeoutCode: "REAL_DOCUMENT_BIND_TIMEOUT" });
  assert.equal(bound, documentId); assert.ok(stages.includes("DOCUMENT_STILL_LOADING"));
  const environment = new ChromeFormEnvironment(selection, { tabs, scripting, documentId: bound });
  assert.equal(await environment.observe(), report);
  assert.equal(calls.length, 3); assert.ok(calls.every((request) => request.injectImmediately === true));
  assert.ok(calls.slice(1).every((request) => request.target.documentIds[0] === documentId));
  tabs.get = async () => ({ id: selection.tabId, url: "https://recruitment.example.test/another" });
  await assert.rejects(environment.observe(), { code: "REAL_PAGE_CHANGED" });
});

test("a stalled Chrome startup call times out and its late completion cannot resume execution", async () => {
  let complete, executed = false;
  const pending = new Promise((resolve) => { complete = resolve; });
  const controller = new AbortController();
  const run = startupStage(() => pending, { signal: controller.signal, timeoutMs: 10,
    timeoutCode: "REAL_DOCUMENT_BIND_TIMEOUT" }).then(() => { executed = true; });
  await assert.rejects(run, { code: "REAL_DOCUMENT_BIND_TIMEOUT" });
  controller.abort(); complete("late-document"); await Promise.resolve();
  assert.equal(executed, false);
});

test("stop cancels startup immediately without waiting for an unresponsive browser", async () => {
  const controller = new AbortController();
  const run = startupStage(() => new Promise(() => {}), { signal: controller.signal,
    timeoutMs: 10_000, timeoutCode: "REAL_DOCUMENT_BIND_TIMEOUT" });
  controller.abort();
  await assert.rejects(run, { code: "USER_STOPPED" });
});

test("socket startup reports open, rejection, and timeout separately", async () => {
  const connected = {};
  const success = openAgentSocket(connected, { timeoutMs: 100 });
  await Promise.resolve(); connected.onopen(); await success;
  const rejected = {};
  const failure = openAgentSocket(rejected, { timeoutMs: 100 });
  await Promise.resolve(); rejected.onclose();
  await assert.rejects(failure, { code: "LOCAL_SERVICE_UNAVAILABLE" });
  await assert.rejects(openAgentSocket({}, { timeoutMs: 10 }), { code: "LOCAL_SERVICE_CONNECT_TIMEOUT" });
});
