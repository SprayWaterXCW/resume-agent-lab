import { writeFile } from "node:fs/promises";
import { createResumeAgent } from "../src/agent/graph.mjs";
import { AgentActionModel } from "../src/agent/model.mjs";
import { OpenAICompatiblePlanner } from "../src/llm/openai-compatible-planner.js";
import { ConfigStore, publicConfig } from "../service/config.mjs";
import { createFixture, scriptedModel } from "../tests/fixture.mjs";

const live = process.argv.includes("--live"), fixture = createFixture({ failFirstMajor: true, extraField: !live });
const events = [], started = Date.now(); let model, planner;
if (live) {
  const env = process.env;
  // Legacy names are accepted only in this explicit live evaluation command. No key is copied into the Lab.
  const config = env.RESUME_AGENT_LAB_API_KEY || env.RESUME_AGENT_API_KEY || env.DEEPSEEK_API_KEY ? {
    apiKey: env.RESUME_AGENT_LAB_API_KEY || env.RESUME_AGENT_API_KEY || env.DEEPSEEK_API_KEY,
    baseUrl: env.RESUME_AGENT_LAB_BASE_URL || env.RESUME_AGENT_BASE_URL || "https://api.deepseek.com",
    model: env.RESUME_AGENT_LAB_MODEL || env.RESUME_AGENT_MODEL || "deepseek-flash",
  } : await new ConfigStore(new URL("../.local", import.meta.url).pathname).read();
  if (!publicConfig(config).configured) throw new Error("MODEL_CONFIG_MISSING: configure the Lab settings page before live evaluation");
  model = new AgentActionModel(config); planner = new OpenAICompatiblePlanner({ ...config,
    disableThinking: new URL(config.baseUrl).hostname === "api.deepseek.com" });
} else { model = scriptedModel({ addFirst: true }); planner = fixture.planner; }
const agent = createResumeAgent({ environment: fixture.environment, model, planner, limits: { maxSteps: 30 },
  onEvent: (event) => { events.push({ step: event.step, phase: event.phase, tool: event.tool, code: event.code,
      ...(event.decisionDiagnostic ? { decisionDiagnostic: event.decisionDiagnostic } : {}),
      ...(event.code === "MODEL_SELECTED_TOOL" ? { counts: event.counts } : {}) });
    console.info(`${event.phase} / ${event.tool} / ${event.code}${event.decisionDiagnostic ? " " + JSON.stringify(event.decisionDiagnostic) : ""}`); } });
try {
  const result = await agent.run();
  const expected = 6;
  const report = { mode: live ? "live_llm_synthetic_environment" : "scripted_model_test_double",
    date: new Date().toISOString(), runtime: "@langchain/langgraph", browserEnvironment: "in-memory fictional form metadata; no real Chrome or recruitment server",
    elapsedMs: Date.now() - started, supportedExpectedFields: expected,
    verifiedSupportedFields: result.result.agentWrittenFields, fullSupportedCoverage: result.result.agentWrittenFields === expected,
    forcedControlFailure: true, modelSelectedRetry: events.some((e) => e.code === "MODEL_SELECTED_TOOL" && e.tool === "retry_field"),
    modelSelectedExpansion: events.some((e) => e.code === "MODEL_SELECTED_TOOL" && e.tool === "add_entry"),
    result: result.result, status: result.status,
    ...(live ? { actionModelHttpRequests: model.metrics.requests, mappingModelHttpRequests: planner.metrics.requests,
      totalInputTokens: model.metrics.inputTokens + planner.metrics.inputTokens, totalOutputTokens: model.metrics.outputTokens + planner.metrics.outputTokens } : {}), events };
  console.info(JSON.stringify(report, null, 2));
  await writeFile(new URL(live ? "../reports/live-evaluation.json" : "../reports/scripted-evaluation.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
  if (result.result.agentWrittenFields !== expected) process.exitCode = 1;
} finally { await agent.dispose(); }
