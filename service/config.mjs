import { chmod, mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const EMPTY_CONFIG = Object.freeze({ schemaVersion: 1, baseUrl: "", model: "", apiKey: "" });
const invalid = () => Object.assign(new Error("CONFIG_INVALID"), { code: "CONFIG_INVALID" });

export function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["schemaVersion", "baseUrl", "model", "apiKey"].includes(key))) throw invalid();
  if (input.schemaVersion !== 1) throw invalid();
  const config = { schemaVersion: 1 };
  for (const [key, max] of [["baseUrl", 1000], ["model", 160], ["apiKey", 4096]]) {
    if (typeof input[key] !== "string" || input[key].length > max || /[\r\n\x00]/.test(input[key])) throw invalid();
    config[key] = input[key].trim();
  }
  if (config.baseUrl) {
    let url;
    try { url = new URL(config.baseUrl); } catch { throw invalid(); }
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && local))
      || url.username || url.password || url.search || url.hash || /\/chat\/completions\/?$/.test(url.pathname)) throw invalid();
    config.baseUrl = url.href.replace(/\/+$/, "");
  }
  return config;
}

export function publicConfig(config) {
  return { baseUrl: config.baseUrl, model: config.model, hasApiKey: Boolean(config.apiKey),
    configured: Boolean(config.baseUrl && config.model && config.apiKey) };
}

export class ConfigStore {
  constructor(directory) { this.directory = directory; this.path = join(directory, "config.json"); this.queue = Promise.resolve(); }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw invalid();
    await chmod(this.directory, 0o700);
    await this.read();
  }
  async read() {
    try {
      if ((await lstat(this.path)).isSymbolicLink()) throw invalid();
      const result = validateConfig(JSON.parse(await readFile(this.path, "utf8")));
      await chmod(this.path, 0o600);
      return result;
    } catch (error) {
      if (error.code === "ENOENT") return { ...EMPTY_CONFIG };
      throw invalid(); // Never include invalid file contents in diagnostics.
    }
  }
  save(input) {
    const operation = this.queue.then(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some((key) => !["baseUrl", "model", "apiKey", "clearApiKey"].includes(key))
        || (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean")) throw invalid();
      const previous = await this.read();
      const config = validateConfig({ schemaVersion: 1, baseUrl: input.baseUrl, model: input.model,
        apiKey: input.clearApiKey === true ? "" : input.apiKey === "" || input.apiKey === undefined ? previous.apiKey : input.apiKey });
      const temporary = join(this.directory, `.config-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(config, null, 2) + "\n"); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      return publicConfig(config);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
