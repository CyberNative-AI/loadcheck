import { analyze } from "./analyze.js";
import { HubError, scanHub } from "./hub.js";
import { sendCompletion } from "./telemetry.js";

const form = document.querySelector("form");
const repo = document.querySelector("#repo");
const revision = document.querySelector("#revision");
const type = document.querySelector("#type");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const button = document.querySelector("button[type=submit]");

function add(parent, tag, value, className) { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; parent.append(node); return node; }
function terminal(title, detail, scan) {
  results.replaceChildren();
  add(results, "h2", title);
  if (detail) add(results, "p", detail);
  if (scan) {
    const meta = document.createElement("dl"); meta.className = "metadata";
    [["Repository", scan.repoId || "Not resolved"], ["Type", scan.type || "Not resolved"], ["Requested revision", scan.requestedRevision || "None"], ["Resolved commit", scan.resolvedSha || "Not resolved"], ["Checked (UTC)", new Date().toISOString()], ["Scan complete", scan.complete ? "Yes" : "No"]].forEach(([key, value]) => { add(meta, "dt", key); add(meta, "dd", value); }); results.append(meta);
  }
  status.textContent = title; sendCompletion();
}
function render(result, scan) {
  terminal(result.verdict, "Loadcheck reports covered loading-risk signals only. Read the evidence before choosing a loading call.", scan);
  if (result.findings.length) {
    const list = document.createElement("ol"); list.className = "findings";
    for (const item of result.findings) { const li = document.createElement("li"); add(li, "h3", `${item.severity}: ${item.name}`); [["Evidence", `${item.path} — ${item.observed}`], ["Common trigger", item.trigger], ["Safer action", item.saferAction]].forEach(([label, value]) => { const p = document.createElement("p"); const strong = document.createElement("strong"); strong.textContent = `${label}: `; p.append(strong, document.createTextNode(value)); li.append(p); }); const link = document.createElement("a"); link.href = item.source; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "Official Hugging Face documentation"; li.append(link); list.append(li); }
    results.append(list);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault(); results.replaceChildren(); button.disabled = true; status.textContent = "Checking repository…";
  const incomplete = { repoId: repo.value.trim(), type: type.value, requestedRevision: revision.value.trim(), resolvedSha: "", complete: false };
  let scan;
  try { scan = await scanHub({ repoId: repo.value, type: type.value, revision: revision.value.trim() }); render(analyze(scan), scan); }
  catch (error) {
    const message = error instanceof HubError ? error.message : "Repository metadata could not be parsed.";
    terminal("Loadcheck could not complete this check.", message, { ...incomplete, ...(scan || error?.context || {}), complete: false });
  }
  finally { button.disabled = false; }
});

button.disabled = false;
