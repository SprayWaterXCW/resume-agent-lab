import { build } from "esbuild";
for (const [entry, output, format] of [["worker.js", "worker.js", "esm"], ["real-page-entry.js", "real-page.js", "iife"],
  ["profile-editor-entry.js", "profile-editor.js", "iife"]]) {
  await build({ entryPoints: [`agent-extension/src/${entry}`], outfile: `agent-extension/dist/${output}`,
    bundle: true, format, platform: "browser", target: "chrome116", legalComments: "none", logLevel: "info" });
}
