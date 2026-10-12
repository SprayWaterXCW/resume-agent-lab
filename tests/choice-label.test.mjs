import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DropdownSelect } from "../src/vendor/formfill/dropdown-select.js";
import { readFormStructure } from "../agent-extension/src/page-scan.js";
import { fillBoundField } from "../agent-extension/src/real-page.js";
import { safeOutcome } from "../src/agent/policy.mjs";

test("a bilingual campus career option commits once and ambiguous alternatives remain unchanged", async () => {
  const dom = new JSDOM(`<section aria-label="基本信息"><label for="channel">信息渠道</label>
    <select id="channel"><option value="">请选择</option><option value="official">公司官网</option>
    <option value="campus">学校就业网&amp;BBS Campus Career Website &amp; BBS</option><option value="account">学校就业公众号</option></select></section>`,
    { url: "https://recruitment.example.test/resume" });
  const names = ["document", "location", "getComputedStyle", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Event"];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const oldBindings = globalThis.__resumeAgentBindings;
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true,
    value: name === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[name] });
  dom.window.Element.prototype.getClientRects = function () { return [{}]; };
  try {
    const select = dom.window.document.querySelector("select"); let changes = 0;
    select.addEventListener("change", () => changes++);
    const execute = async () => {
      const report = readFormStructure(dom.window.location.href, true);
      return fillBoundField({ token: globalThis.__resumeAgentBindings.token, fieldId: report.fields[0].id,
        sourcePath: "jobPreferences.discoveryChannel", value: "学校就业网" });
    };
    const outcome = await execute();
    assert.equal(outcome.verified, true); assert.equal(select.value, "campus"); assert.equal(changes, 1);
    assert.equal(safeOutcome(outcome).diagnostic.adapter, "native_select");
    select.insertAdjacentHTML("beforeend", '<option value="alternative">高校就业信息平台 University Career Portal</option>');
    const ambiguous = await execute();
    assert.equal(ambiguous.code, "OPTION_UNAVAILABLE"); assert.equal(select.value, "campus"); assert.equal(changes, 1);
    assert.equal(safeOutcome(ambiguous).diagnostic.optionCount, 4);
    assert.equal(JSON.stringify(safeOutcome(ambiguous)).includes("学校就业网"), false);
    assert.ok(DropdownSelect.scoreOption("学校就业信息网/学校Career Center", "学校就业网") >= 0.85);
    assert.ok(DropdownSelect.scoreOption("公司官网 Company Career Website", "学校就业网") < 0.85);
  } finally {
    for (const [name, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];
    globalThis.__resumeAgentBindings = oldBindings; dom.window.close();
  }
});
