const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="lab-token"]').content;
async function api(path, data) {
  const response = await fetch(path, { method: data === undefined ? "GET" : "POST",
    headers: { "X-Lab-Token": token, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const body = await response.json(); if (!response.ok) throw new Error(body.code || "SETTINGS_REQUEST_FAILED"); return body;
}
async function load() {
  const config = await api("/api/settings"); $("base").value = config.baseUrl; $("model").value = config.model;
  $("key").value = ""; $("key-state").textContent = config.hasApiKey ? "本机已有密钥；不会返回明文。" : "尚未配置密钥。";
  $("extension-path").textContent = config.extensionPath;
  $("service").textContent = config.configured ? "LangGraph 服务已运行 · 模型已配置" : "LangGraph 服务已运行 · 待配置模型";
  if (config.configFromEnvironment) $("message").textContent = "当前使用启动时环境配置；修改后需重启服务。";
}
async function save() {
  await api("/api/settings", { baseUrl: $("base").value, model: $("model").value, apiKey: $("key").value });
  $("key").value = ""; await load(); $("message").textContent = "模型配置已保存。";
}
$("settings").onsubmit = async (event) => { event.preventDefault(); try { await save(); } catch (error) { $("message").textContent = error.message; } };
$("probe").onclick = async () => {
  $("probe").disabled = true; $("message").textContent = "正在测试一次真实模型工具调用…";
  try { await save(); await api("/api/test-model", {}); $("message").textContent = "工具调用返回格式已验证。真实网页填写效果需要单独验收。"; }
  catch (error) { $("message").textContent = error.message; } finally { $("probe").disabled = false; }
};
$("copy-path").onclick = async () => { try { await navigator.clipboard.writeText($("extension-path").textContent); $("copy-path").textContent = "已复制"; }
  catch { $("message").textContent = "复制失败，请手动选中目录。"; } };
void load().catch((error) => { $("message").textContent = error.message; });
