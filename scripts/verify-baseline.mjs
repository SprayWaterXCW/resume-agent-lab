import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
const manifest = JSON.parse(await readFile(new URL("../reports/stable-baseline-manifest.json", import.meta.url), "utf8"));
const base = new URL("../../RESUME_AGENT/", import.meta.url).pathname;
const files = Array.isArray(manifest.files) ? manifest.files : Object.entries(manifest.files).map(([path, sha256]) => ({ path, sha256 }));
const changed = [];
for (const entry of files) {
  const relative = entry.path || entry.name;
  try { if (createHash("sha256").update(await readFile(join(base, relative))).digest("hex") !== entry.sha256) changed.push(relative); }
  catch { changed.push(relative); }
}
console.info(JSON.stringify({ baselineFiles: files.length, changedFiles: changed.length, changed }, null, 2));
if (changed.length) process.exitCode = 1;
