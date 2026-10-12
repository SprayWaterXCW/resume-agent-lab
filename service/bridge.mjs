import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { createResumeAgent } from "../src/agent/graph.mjs";
import { startMessageSchema, toolRequestSchema } from "../src/runtime/protocol.mjs";
import { safeCode } from "../src/agent/policy.mjs";
import { toolFailureDiagnosticSchema } from "../src/core/observation-diagnostics.js";

export function attachChromeBridge(server, { port, extensionOrigin, getModels, onRecord = () => {}, maxTasks = 8 }) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 350_000 });
  const sessions = new Set();
  const send = (client, value) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/agent" || request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== extensionOrigin) {
      socket.destroy(); return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });
  sockets.on("connection", (client) => {
    const session = { runId: null, agent: null, controller: new AbortController(), pending: new Map(), running: false, closed: false };
    sessions.add(session);
    const rpc = (method, args) => new Promise((resolve, reject) => {
      if (session.closed || session.controller.signal.aborted || client.readyState !== WebSocket.OPEN) {
        reject(Object.assign(new Error("USER_STOPPED"), { code: "USER_STOPPED" })); return;
      }
      const checked = toolRequestSchema.parse({ method, args });
      const id = randomUUID();
      const timer = setTimeout(() => {
        session.pending.delete(id); reject(Object.assign(new Error("CHROME_TOOL_TIMEOUT"), { code: "CHROME_TOOL_TIMEOUT" }));
      }, 125_000);
      session.pending.set(id, { timer, resolve, reject });
      send(client, { type: "tool", runId: session.runId, id, ...checked });
    });
    const environment = {
      observe: (args) => rpc("observe", args),
      inspect: (fieldId) => rpc("inspect", { fieldId }),
      fill: (item, { retry = false, proposal }) => rpc("fill", { item: { fieldId: item.fieldId, sourcePath: item.sourcePath }, retry, proposal }),
      add: (groupId, { proposal }) => rpc("add", { groupId, proposal }),
      audit: (targets) => rpc("audit", { targets }),
      wait: (milliseconds) => rpc("wait", { milliseconds }),
    };
    const abort = () => {
      session.controller.abort();
      for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error("USER_STOPPED"), { code: "USER_STOPPED" })); }
      session.pending.clear();
    };
    const run = async (resume) => {
      session.running = true;
      try {
        const result = resume ? await session.agent.resume("continue") : await session.agent.run();
        send(client, { type: "result", runId: session.runId, ...result });
        onRecord({ runId: session.runId, status: result.status, result: result.result });
        if (result.status !== "waiting_review") { await session.agent.dispose(); session.agent = null; }
      } catch (error) {
        const code = safeCode(error?.code, session.controller.signal.aborted ? "USER_STOPPED" : "AGENT_RUNTIME_FAILED");
        const parsed = toolFailureDiagnosticSchema.safeParse(error?.toolDiagnostic);
        const diagnostic = parsed.success ? { toolDiagnostic: parsed.data } : {};
        send(client, { type: "error", runId: session.runId, code, ...diagnostic }); onRecord({ runId: session.runId, code, ...diagnostic });
        await session.agent?.dispose(); session.agent = null;
      } finally {
        session.running = false;
        if (session.closed) await session.agent?.dispose();
      }
    };
    client.on("message", async (raw) => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { client.close(1003, "Invalid JSON"); return; }
      if (message.type === "ping") { send(client, { type: "pong" }); return; }
      if (message.type === "tool_result") {
        const pending = session.pending.get(message.id);
        if (!pending || message.runId !== session.runId) return;
        clearTimeout(pending.timer); session.pending.delete(message.id);
        if (message.ok === true) pending.resolve(message.result);
        else {
          const parsed = toolFailureDiagnosticSchema.safeParse(message.toolDiagnostic);
          pending.reject(Object.assign(new Error(safeCode(message.code)), { code: safeCode(message.code),
            ...(parsed.success ? { toolDiagnostic: parsed.data } : {}) }));
        }
        return;
      }
      if (message.type === "stop" && message.runId === session.runId) {
        abort();
        if (!session.running) { await session.agent?.dispose(); session.agent = null;
          send(client, { type: "error", runId: session.runId, code: "USER_STOPPED" }); }
        return;
      }
      if (message.type === "resume" && message.runId === session.runId && session.agent && !session.running) {
        void run(true); return;
      }
      const start = startMessageSchema.safeParse(message);
      if (!start.success || session.runId || [...sessions].filter((s) => s.agent).length >= maxTasks) {
        send(client, { type: "error", ...(start.success ? { runId: start.data.runId } : {}), code: "AGENT_START_DENIED" }); return;
      }
      session.runId = start.data.runId;
      let models;
      try { models = await getModels(); }
      catch { send(client, { type: "error", runId: session.runId, code: "MODEL_CONFIG_MISSING" }); return; }
      if (session.closed) return;
      session.agent = createResumeAgent({ ...models, environment, signal: session.controller.signal, threadId: session.runId,
        onEvent: (event) => send(client, { type: "event", runId: session.runId, event }) });
      void run(false);
    });
    client.on("close", () => { session.closed = true; abort(); sessions.delete(session); if (!session.running) void session.agent?.dispose(); });
    client.on("error", () => abort());
  });
  return { sockets, get activeCount() { return [...sessions].filter((s) => s.agent).length; },
    close() { for (const session of sessions) session.controller.abort(); for (const client of sockets.clients) client.close(); sockets.close(); } };
}
