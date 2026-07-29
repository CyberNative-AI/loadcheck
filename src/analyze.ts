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
 * Parses only the bounded YAML front matter required for configs inspection.
 * It never evaluates tags, anchors, aliases, templates, or repository code.
 */
export function inspectConfigsFrontMatter(readme) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readme);
  if (!match) return { hasConfigs: false, templates: [] };
  const body = match[1];
  if (/\t|(^|\s)(!!|&|\*)[^\s]/m.test(body)) throw new Error("Unsupported YAML feature in repository metadata.");
  const lines = body.split(/\r?\n/);
  let inConfigs = false;
  let configsIndent = -1;
  let item = -1;
  const templates = [];
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();
    if (!inConfigs) {
      if (line === "configs:") { inConfigs = true; configsIndent = indent; }
      continue;
    }
    if (indent <= configsIndent && !line.startsWith("-")) break;
    const singleQuotes = (line.match(/'/g) || []).length;
    const doubleQuotes = (line.match(/"/g) || []).length;
    if (line.includes("[") && !line.includes("]") || singleQuotes % 2 || doubleQuotes % 2) throw new Error("Malformed YAML front matter.");
    if (line.startsWith("-")) item += 1;
    const field = /^-?\s*([^:#][^:]*):/.exec(line);
    const key = field ? field[1].trim() : "value";
    const path = `README.md → configs[${Math.max(item, 0)}].${key}`;
    for (const delimiter of JINJA) if (delimiter.pattern.test(line)) {
      templates.push({ path, delimiter: delimiter.name });
    }
  }
  return { hasConfigs: inConfigs, templates };
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
