import { pause } from "./page-wait.js";

/** Fixed component bridge, never a model supplied script, selector or callback. */
export function openLegacyPicker(request, expectedUrl) {
  if (location.href !== expectedUrl || !/^[a-f0-9-]{36}$/.test(request?.ticket || "")) return { opened: false };
  const matches = [...document.querySelectorAll("input[data-resume-agent-picker]")]
    .filter((el) => el.getAttribute("data-resume-agent-picker") === request.ticket);
  const el = matches.length === 1 ? matches[0] : null;
  if (!el?.isConnected || !el.readOnly || el.disabled) return { opened: false };
  if (request.component === "legacy_area" && el.matches('.ConstDictSingleSelect[constname="Areas"]')) {
    const hidden = el.nextElementSibling;
    if (!hidden?.matches('input[type="hidden"][name]') || hidden.form !== el.form || typeof globalThis.jQuery?.fn?.basSelect !== "function") return { opened: false };
    // This widget reads TenantId from its native page context. Calling it
    // before that context exists requests /api/setting/undefined (HTTP 400).
    // Do not create guessed context or open a dialog that cannot load data.
    if (!/^[1-9]\d*$/.test(String(globalThis.BSGlobal?.TenantId || ""))) return { opened: false, code: "PICKER_CONTEXT_NOT_READY" };
    // Use the website's own observed widget protocol, including its dictionary
    // and hidden ID host. Never fabricate a region ID or write a display alone.
    if (document.querySelector(".bas_select_wrap")) return { opened: false };
    globalThis.jQuery(el).basSelect({ type: "radio", data: "NewAjson", valHost: hidden, title: "选择地区", map: { id: "k", text: "v", children: "c" } });
    const panel = document.querySelector(".bas_select_wrap");
    if (!panel) return { opened: false };
    panel.setAttribute("data-resume-agent-picker-panel", request.ticket);
    return { opened: true };
  }
  if (request.component === "my97_calendar" && el.matches(".Wdate") && typeof globalThis.WdatePicker === "function"
    && /^\d{4}-\d{2}-\d{2}$/.test(request.date || "")) {
    globalThis.WdatePicker({ el, dateFmt: "yyyy-MM-dd", startDate: request.date,
      alwaysUseStartDate: true, isShowToday: false, isShowClear: false });
    return { opened: true };
  }
  return { opened: false };
}

export function inspectPickerRuntime(expectedUrl) {
  if (location.href !== expectedUrl) return {};
  return { documentReady: document.readyState !== "loading", areaApiAvailable: typeof globalThis.jQuery?.fn?.basSelect === "function",
    areaContextReady: /^[1-9]\d*$/.test(String(globalThis.BSGlobal?.TenantId || "")),
    calendarApiAvailable: typeof globalThis.WdatePicker === "function" };
}

/** Public dictionary-loading metadata only; no tenant IDs, URLs or form values. */
export function inspectAreaLoad(expectedUrl) {
  if (location.href !== expectedUrl) return {};
  let rootHost = "const.italent.cn";
  try { rootHost = new URL(globalThis.BSGlobal?.constSite || "//const.italent.cn", location.href).hostname; } catch { /* No guessed alternate host. */ }
  const seen = { settings: false, areas: false, pinyin: false };
  let count = 0;
  for (const entry of performance.getEntriesByType("resource").slice(-3000)) {
    try {
      const url = new URL(entry.name);
      if (![rootHost, "const.italent.cn"].includes(url.hostname)) continue;
      const stage = /^\/api\/setting\/[^/]+$/.test(url.pathname) ? "settings"
        : /^\/resource\/Areas-(?:chs|en)-[^/]+\.js$/.test(url.pathname) ? "areas"
        : /^\/property\/Areas\/Pinyin\.js$/.test(url.pathname) ? "pinyin" : null;
      if (stage) { seen[stage] = true; count++; }
    } catch { /* Ignore unrelated resource names. */ }
  }
  return { dictionarySettingsObserved: seen.settings, dictionaryAreasObserved: seen.areas,
    dictionaryPinyinObserved: seen.pinyin, dictionaryAvailable: Array.isArray(globalThis.NewAjson) && globalThis.NewAjson.length > 0,
    areaContextReady: /^[1-9]\d*$/.test(String(globalThis.BSGlobal?.TenantId || "")),
    dictionaryRequestCount: Math.min(1000, count) };
}

const compact = (value) => String(value || "").replace(/[\s\u200b\ufeff]/g, "");
const regionName = (value) => compact(value).replace(/(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|省|市|地区|盟|区|县)$/, "");
const click = (el) => { if (!el || el.disabled || el.type === "submit") return false; el.click(); return true; };

/** Complete only the already bound calendar/area operation. Private values stay here. */
export async function completeLegacyPicker(binding, value, regionParts, state, opened) {
  const component = binding.field.component, started = Date.now();
  let phase = "wait", panel, levelCount = 0, optionCount = 0, pathMatched = false, valueMatched = false, hiddenValuePresent = false;
  const valid = () => binding.assertIdentity() && location.href === state.expectedUrl;
  const visible = (el) => el?.isConnected && state.visible(el);
  const waitFor = async (read, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    do { if (!valid()) return null; const found = read(); if (found) return found; await pause(150); } while (Date.now() < deadline);
    return null;
  };
  const cancel = () => {
    const cancel = panel?.querySelector(".bas_select_buttons .bas_btn_canc");
    if (visible(cancel) && /^(取消|Cancel)$/i.test(compact(cancel.textContent))) click(cancel);
  };
  const finish = (code, verified = false) => {
    if (!verified) cancel();
    return { code, verified, optionCount, diagnostic: { phase, adapter: component,
      levelCount, pathMatched, valueMatched, hiddenValuePresent, identityVerified: valid(),
      pageStateObserved: component === "legacy_area", pageStateMatched: verified && hiddenValuePresent,
      waitedMs: Math.min(60_000, Date.now() - started) } };
  };
  if (!opened) return finish("PICKER_API_UNAVAILABLE");
  if (component === "legacy_area") {
    // Bind ownership before waiting for data. An empty, failed dictionary
    // load must still close only this operation's dialog on failure.
    const ownedPanels = [...document.querySelectorAll(".bas_select_wrap")]
      .filter((el) => el.getAttribute("data-resume-agent-picker-panel") === binding.element.getAttribute("data-resume-agent-picker"));
    if (ownedPanels.length !== 1) return finish("PICKER_NOT_BOUND");
    panel = ownedPanels[0];
    const parts = regionParts.filter((part, index) => !index || compact(part) !== compact(regionParts[index - 1]));
    if (!parts.length || parts.length > 3) return finish("SOURCE_UNAVAILABLE");
    if (!await waitFor(() => visible(panel) && panel.querySelector(".bas_select_ctt .lst_item input"), 40_000)) return finish("DICTIONARY_NOT_LOADED");
    const available = () => [...panel.querySelectorAll('.bas_select_ctt .lst_item input[type="radio"]')]
      .filter(visible).map((el) => ({ el, row: el.closest("li"), label: el.parentElement.querySelector("label, span")?.textContent
        || el.parentElement.textContent })).filter((item) => compact(item.label));
    let picked;
    for (const [index, part] of parts.entries()) {
      phase = "navigate";
      const options = available(); optionCount = options.length;
      const matches = options.filter((item) => regionName(item.label) === regionName(part));
      if (matches.length !== 1) return finish(matches.length ? "PICKER_AMBIGUOUS" : "REGION_LEVEL_UNAVAILABLE");
      picked = matches[0]; levelCount++;
      if (index === parts.length - 1) break;
      const arrow = picked.row?.querySelector(".pr .uf");
      if (!visible(arrow)) return finish("REGION_NAVIGATION_UNAVAILABLE");
      const old = new Set(options.map((item) => item.el));
      click(arrow);
      if (!await waitFor(() => available().some((item) => !old.has(item.el)))) return finish("REGION_NAVIGATION_NOT_OBSERVED");
    }
    phase = "select"; click(picked.el);
    if (!await waitFor(() => picked.el.checked, 1500)) return finish("PICKER_SELECTION_NOT_OBSERVED");
    // The traversal itself proves the parent chain; the page owns the chosen ID.
    pathMatched = levelCount === parts.length;
    const confirm = panel.querySelector(".bas_select_buttons .bas_btn_save");
    if (!visible(confirm) || !/^(确定|Ok)$/i.test(compact(confirm.textContent)) || !valid()) return finish("PICKER_CONFIRM_UNAVAILABLE");
    phase = "commit"; click(confirm);
    const hidden = binding.element.nextElementSibling;
    const committed = await waitFor(() => {
      hiddenValuePresent = Boolean(hidden?.matches('input[type="hidden"][name]') && hidden.value);
      valueMatched = regionName(binding.element.value) === regionName(parts.at(-1));
      return !panel.isConnected && hiddenValuePresent && valueMatched;
    }, 2000);
    if (committed) {
      for (const el of [binding.element, hidden]) for (const type of ["input", "change"]) el.dispatchEvent(new Event(type, { bubbles: true }));
    }
    return finish(committed ? "VERIFIED" : "PICKER_NOT_COMMITTED", Boolean(committed));
  }
  if (component === "my97_calendar") {
    let doc;
    panel = await waitFor(() => {
      const calendars = [...document.querySelectorAll("iframe")].flatMap((frame) => {
        try { const root = frame.contentDocument?.querySelector(".WdateDiv"); return root && visible(frame) ? [{ root, doc: frame.contentDocument }] : []; }
        catch { return []; }
      });
      if (calendars.length !== 1) return null;
      doc = calendars[0].doc; return calendars[0].root;
    });
    if (!panel) return finish("CALENDAR_NOT_LOADED");
    const [year, month, day] = value.split("-").map(Number);
    const header = [...panel.querySelectorAll(".dpTitle input.yminput")].map((el) => Number((el.value || "").match(/\d+/)?.[0]));
    pathMatched = header.includes(year) && header.includes(month);
    if (!pathMatched) return finish("CALENDAR_VIEW_MISMATCH");
    const cells = [...panel.querySelectorAll(".WdayTable td")].filter((el) => /^(Wday|Wwday|Wtoday|Wselday)$/.test(el.className)
      && compact(el.textContent) === String(day));
    optionCount = cells.length;
    if (cells.length !== 1 || !valid()) return finish("CALENDAR_DAY_UNAVAILABLE");
    phase = "select"; click(cells[0]);
    phase = "commit";
    const committed = await waitFor(() => { valueMatched = binding.element.value === value; return valueMatched; }, 2000);
    if (committed) for (const type of ["input", "change"]) binding.element.dispatchEvent(new Event(type, { bubbles: true }));
    return finish(committed ? "VERIFIED" : "PICKER_NOT_COMMITTED", Boolean(committed));
  }
  return finish("CONTROL_UNSUPPORTED");
}
