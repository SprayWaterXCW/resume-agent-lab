const state = new Map();
function render() {
  const entries = document.querySelectorAll("[data-agent-entry]");
  document.getElementById("business-state").textContent = `业务状态：已接收 ${[...state.values()].filter(Boolean).length} 个字段 · 教育 ${entries.length} 组`;
  const list = document.getElementById("accepted"); list.replaceChildren();
  for (const [key, value] of state) { const li = document.createElement("li"); li.textContent = `${key}：${value ? "已接收" : "空白"}`; list.append(li); }
}
function attach(input) {
  const update = () => { state.set(input.id, input.value); render(); };
  input.addEventListener("input", update); input.addEventListener("change", update);
}
document.querySelectorAll("input[data-key]").forEach(attach);
document.getElementById("add-education").onclick = () => {
  const entries = document.getElementById("entries"), index = entries.children.length;
  if (index >= 20) return;
  const article = entries.firstElementChild.cloneNode(true);
  article.querySelectorAll("input").forEach((input) => { input.value = ""; input.id = `${input.dataset.key}-${index}`; attach(input); });
  article.querySelectorAll("label").forEach((label) => { label.htmlFor = label.htmlFor.replace(/-\d+$/, "-" + index); });
  entries.append(article); render();
};
render();
