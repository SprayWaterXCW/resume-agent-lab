import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createLabServer } from "./server.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const localEnv = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(localEnv)) process.loadEnvFile(localEnv);
const env = process.env;
const envConfig = env.RESUME_AGENT_LAB_API_KEY ? { schemaVersion: 1, baseUrl: env.RESUME_AGENT_LAB_BASE_URL || "", model: env.RESUME_AGENT_LAB_MODEL || "", apiKey: env.RESUME_AGENT_LAB_API_KEY } : undefined;
const port = Number(env.RESUME_AGENT_LAB_PORT || 4175);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT_INVALID");
const service = await createLabServer({ root, port, envConfig,
  onRecord: (record) => console.info(JSON.stringify(record)) });
console.info(`Resume Agent Lab: http://127.0.0.1:${service.port}/ (LangGraph + model-directed tools)`);
console.info("Model settings and profile start independently; the stable plugin service remains on 4174.");
let closing = false;
for (const event of ["SIGINT", "SIGTERM"]) process.on(event, async () => {
  if (closing) return; closing = true; await service.close(); process.exit(0);
});
