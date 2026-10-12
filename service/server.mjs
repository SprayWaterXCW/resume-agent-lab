import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { ConfigStore, publicConfig, validateConfig } from "./config.mjs";
import { AgentActionModel } from "../src/agent/model.mjs";
import { OpenAICompatiblePlanner } from "../src/llm/openai-compatible-planner.js";
import { attachChromeBridge } from "./bridge.mjs";

export function extensionId(key) {
  return [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)].map((n) => String.fromCharCode(97 + parseInt(n, 16))).join("");
}
export async function createLabServer({ root, port = 4175, dataDirectory = join(root, ".local"), envConfig, modelsFactory, onRecord = () => {} }) {
  const store = new ConfigStore(dataDirectory); await store.init();
  const manifest = JSON.parse(await readFile(join(root, "agent-extension/manifest.json"), "utf8"));
  const id = extensionId(manifest.key), csrf = randomBytes(32).toString("hex");
  const effectiveConfig = async () => envConfig ? validateConfig(envConfig) : store.read();
  const getModels = modelsFactory || (async () => {
    const config = await effectiveConfig(); if (!publicConfig(config).configured) throw new Error("MODEL_CONFIG_MISSING");
    return { model: new AgentActionModel(config), planner: new OpenAICompatiblePlanner({ ...config,
      disableThinking: new URL(config.baseUrl).hostname === "api.deepseek.com" }) };
  });
  const files = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"],
    "/style.css": ["style.css", "text/css"], "/practice": ["practice.html", "text/html"], "/practice.js": ["practice.js", "text/javascript"] };
  let bridge;
  const json = (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  const tokenOK = (request) => {
    const token = request.headers["x-lab-token"];
    return typeof token === "string" && Buffer.byteLength(token) === Buffer.byteLength(csrf) && timingSafeEqual(Buffer.from(token), Buffer.from(csrf));
  };
  const readJson = async (request) => {
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 12_000) throw new Error("BODY_TOO_LARGE"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const server = createServer(async (request, response) => {
    const actualPort = server.address()?.port || port;
    const origin = `http://127.0.0.1:${actualPort}`;
    if (request.headers.host !== `127.0.0.1:${actualPort}`) return json(response, 403, { code: "LOCAL_HOST_ONLY" });
    let path;
    try { path = new URL(request.url, origin).pathname; } catch { return json(response, 400, { code: "REQUEST_INVALID" }); }
    if (request.method === "GET" && path === "/api/status") return json(response, 200, {
      serviceId: "resume-agent-lab", version: "0.1.7", agentRuntime: "langgraph_model_directed", port: actualPort,
      extensionId: id, modelConfigured: publicConfig(await effectiveConfig()).configured, activeTasks: bridge?.activeCount || 0,
    });
    if (request.method === "GET" && files[path]) {
      const [name, type] = files[path]; let body = await readFile(join(root, "web", name), "utf8");
      if (path === "/") body = body.replace("__LAB_TOKEN__", csrf);
      response.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'" });
      response.end(body); return;
    }
    if (!path.startsWith("/api/") || !tokenOK(request) || request.method === "POST" && (request.headers.origin !== origin
      || !request.headers["content-type"]?.startsWith("application/json"))) return json(response, 403, { code: "LOCAL_TOKEN_REQUIRED" });
    try {
      if (request.method === "GET" && path === "/api/settings") return json(response, 200, {
        ...publicConfig(await effectiveConfig()), extensionId: id, extensionPath: join(root, "agent-extension"),
        configFromEnvironment: Boolean(envConfig), activeTasks: bridge.activeCount,
      });
      if (request.method === "POST" && path === "/api/settings") {
        if (bridge.activeCount || envConfig) return json(response, 409, { code: "SETTINGS_BUSY_OR_ENV_CONFIG" });
        return json(response, 200, await store.save(await readJson(request)));
      }
      if (request.method === "POST" && path === "/api/test-model") {
        if (bridge.activeCount) return json(response, 409, { code: "AGENT_BUSY" });
        const { model } = await getModels();
        const snapshotId = "a".repeat(64);
        const decision = await model.decide({ snapshotId, goal: "Connection probe only: call wait for 100 milliseconds, using this snapshotId.",
          planAvailable: false, page: { fields: [], groups: [] }, profileCatalog: [], pendingFields: [], retryableFields: [],
          missingEntries: [], recentHistory: [], lastResult: null }, { probe: true });
        if (decision.action.tool !== "wait" || decision.action.snapshotId !== snapshotId) throw new Error("MODEL_TOOL_PROTOCOL_INVALID");
        return json(response, 200, { code: "MODEL_TOOL_CALL_VERIFIED" });
      }
      return json(response, 404, { code: "NOT_FOUND" });
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{1,90}$/.test(error?.code || error?.message || "") ? error.code || error.message : "SETTINGS_REQUEST_FAILED";
      return json(response, 400, { code, ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}) });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  bridge = attachChromeBridge(server, { port: server.address().port, extensionOrigin: `chrome-extension://${id}`, getModels, onRecord });
  return { server, bridge, store, port: server.address().port, extensionId: id, csrf,
    async close() { bridge.close(); await new Promise((resolve) => server.close(resolve)); } };
}
