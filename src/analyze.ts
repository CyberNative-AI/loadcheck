/** Pure, network-free detection rules for Loadcheck. */
export const FULL_SHA = /^[a-f0-9]{40}$/i;
const PICKLE = /\.(bin|pt|pth|ckpt|pkl|pickle)$/i;
const JINJA = [
  { pattern: /\{\{/, name: "expression delimiter" },
  { pattern: /\{%/, name: "statement delimiter" },
  { pattern: /\{#/, name: "comment delimiter" }
];

export const OFFICIAL = {
  transformers: "https://huggingface.co/docs/transformers/main_classes/model#transformers.PreTrainedModel.from_pretrained",
  datasets: "https://huggingface.co/docs/datasets/dataset_script",
  configs: "https://huggingface.co/docs/hub/datasets-manual-configuration",
  pickle: "https://huggingface.co/docs/hub/security-pickle",
  revisions: "https://huggingface.co/docs/transformers/main_classes/model#transformers.PreTrainedModel.from_pretrained"
};

function finding(severity, name, path, observed, trigger, saferAction, source) {
  return { severity, name, path, observed, trigger, saferAction, source };
}

function valuesAt(value, path, output) {
  if (typeof value === "string") output.push({ path, value });
  else if (Array.isArray(value)) value.forEach((item, index) => valuesAt(item, `${path}[${index}]`, output));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => valuesAt(item, `${path}.${key}`, output));
}

function localModule(value) {
  if (value.includes("--")) return null;
  const module = value.split(".")[0];
  return module && /^[A-Za-z0-9_/-]+$/.test(module) ? `${module}.py` : null;
}

/**
 * Inspects only a constrained YAML front matter subset. It treats all values as
 * text: tags, anchors, aliases, block scalars, and interpolation are rejected
 * before traversal, so repository data is never executed or rendered.
 */
export function inspectConfigsFrontMatter(readme) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readme);
  if (!match) return { hasConfigs: false, templates: [] };
  const body = match[1];
  if (/\t|(^|\s)![^\s]|(^|\s)[&*][A-Za-z_]/m.test(body)) throw new Error("Unsupported YAML feature in repository metadata.");
  const lines = body.split(/\r?\n/);
  let configsIndent = null;
  const templates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    if (line.trim() === "configs:") { configsIndent = indent; break; }
  }
  if (configsIndent === null) return { hasConfigs: false, templates };

  const root = "README.md → configs";
  const stack = [{ indent: configsIndent, path: root }];
  const sequenceCounts = new Map();
  const inspect = (path, value) => {
    const quotes = (value.match(/'/g) || []).length + (value.match(/"/g) || []).length;
    if (quotes % 2 || (value.includes("[") && !value.includes("]"))) throw new Error("Malformed YAML front matter.");
    for (const delimiter of JINJA) if (delimiter.pattern.test(value)) templates.push({ path, delimiter: delimiter.name });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^ */)[0].length;
    let line = raw.trim();
    if (line === "configs:") continue;
    if (indent <= configsIndent && !line.startsWith("-")) break;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    let parent = stack[stack.length - 1];
    if (line.startsWith("-")) {
      const counter = parent.path + "@" + indent;
      const item = sequenceCounts.get(counter) || 0;
      sequenceCounts.set(counter, item + 1);
      parent = { indent, path: parent.path + "[" + item + "]" };
      stack.push(parent);
      line = line.slice(1).trim();
      if (!line) continue;
    }
    const field = /^([^:#][^:]*):(?:\s*(.*))?$/.exec(line);
    if (!field) { inspect(parent.path, line); continue; }
    const key = field[1].trim();
    const value = field[2] || "";
    if (!key) throw new Error("Malformed YAML front matter.");
    const path = parent.path + "." + key;
    if (value === "|" || value === ">") throw new Error("Unsupported YAML feature in repository metadata.");
    inspect(path, value);
    if (!value) stack.push({ indent, path });
  }
  return { hasConfigs: true, templates };
}

export function analyze(input) {
  const { repoId, type, requestedRevision, resolvedSha, paths, config, readme } = input;
  if (!FULL_SHA.test(resolvedSha || "")) throw new Error("Repository resolution did not return a full commit SHA.");
  const findings = [];
  const tree = new Set(paths);
  if (type === "model" && config) {
    if (config.auto_map !== undefined && (!config.auto_map || typeof config.auto_map !== "object")) throw new Error("config.json auto_map must be an object.");
    const mappings = [];
    if (config.auto_map) valuesAt(config.auto_map, "config.json → auto_map", mappings);
    for (const mapping of mappings) {
      const local = localModule(mapping.value);
      const named = local && tree.has(local) ? `; confirmed local file ${local}` : "";
      const cross = mapping.value.includes("--") ? "cross-repository reference" : "custom AutoClass mapping";
      findings.push(finding("high", "Custom model code", mapping.path, `${cross}: ${mapping.value}${named}`, `AutoModel.from_pretrained(\"${repoId}\", trust_remote_code=True)`, `Inspect the named code, then pin revision=\"${resolvedSha}\"${local ? ` and code_revision=\"${resolvedSha}\"` : ""}.`, OFFICIAL.transformers));
    }
  }
  if (type === "dataset") {
    const repoName = repoId.split("/")[1];
    const loader = `${repoName}.py`;
    if (tree.has(loader)) findings.push(finding("high", "Dataset loading script", loader, "Root-level dataset loading script present.", `load_dataset(\"${repoId}\", trust_remote_code=True)`, `Use supported data files without remote code, or inspect ${loader} and pin ${resolvedSha} before opting in.`, OFFICIAL.datasets));
    if (readme) for (const hit of inspectConfigsFrontMatter(readme).templates) {
      findings.push(finding("high", "Template syntax in dataset configuration", hit.path, hit.delimiter, "Dataset processing or viewer code that interprets repository configuration.", `Do not load or render this configuration; inspect it and use explicit local data-file arguments at ${resolvedSha}.`, OFFICIAL.configs));
    }
  }
  const pickles = paths.filter(path => PICKLE.test(path));
  const hasSafeTensors = paths.some(path => /\.safetensors$/i.test(path));
  if (type === "model" && pickles.length && !hasSafeTensors) {
    const shown = pickles.slice(0, 20);
    const suffix = pickles.length > shown.length ? `; ${pickles.length - shown.length} additional path(s) omitted` : "";
    findings.push(finding("medium", "Pickle-capable weights", shown.join(", "), `Found ${pickles.length} candidate path(s): ${shown.join(", ")}${suffix}.`, "A library load path that deserializes the named checkpoint.", "Prefer a verified safetensors release, or convert and review the checkpoint before loading.", OFFICIAL.pickle));
  }
  const pinned = FULL_SHA.test(requestedRevision || "");
  if (!pinned) findings.push(finding("low", "Unpinned revision", "revision", requestedRevision || "No revision supplied.", `from_pretrained(\"${repoId}\")`, `Pin this call with revision=\"${resolvedSha}\".`, OFFICIAL.revisions));
  findings.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - ({ high: 0, medium: 1, low: 2 }[b.severity])));
  const top = findings[0];
  const verdict = top?.severity === "high" ? "Repository code can run when this repo is loaded."
    : top?.name === "Pickle-capable weights" ? "Loading may deserialize pickle-capable weights."
    : top ? "Pin this repository before loading it."
    : "No covered code-execution signal found at this commit.";
  return { complete: true, verdict, findings, resolvedSha };
}
