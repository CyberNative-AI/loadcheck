import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

/** Pure, network-free detection rules for Loadcheck. */
export const FULL_SHA = /^[a-f0-9]{40}$/i;
const PICKLE = /\.(bin|pt|pth|ckpt|pkl|pickle)$/i;
const JINJA = [
  { pattern: /\{\{/, name: "expression delimiter" },
  { pattern: /\{%/, name: "statement delimiter" },
  { pattern: /\{#/, name: "comment delimiter" }
];

export const OFFICIAL = {
  transformers: "https://huggingface.co/docs/transformers/model_doc/auto",
  datasets: "https://huggingface.co/docs/datasets/v3.4.0/en/dataset_script",
  configs: "https://huggingface.co/docs/hub/en/datasets-manual-configuration",
  pickle: "https://huggingface.co/docs/hub/security-pickle",
  revisions: "https://huggingface.co/docs/transformers/models"
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

function yamlPath(path, key) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function rejectUnsafeYaml(node) {
  if (!node) return;
  if (isAlias(node) || node.anchor || (node.tag && node.tag.startsWith("!"))) {
    throw new Error("Unsupported YAML feature in repository metadata.");
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw new Error("Unsupported YAML map key in repository metadata.");
      rejectUnsafeYaml(pair.key);
      rejectUnsafeYaml(pair.value);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) rejectUnsafeYaml(item);
  }
}

function inspectYamlValue(node, path, templates) {
  if (!node) return;
  if (isScalar(node)) {
    if (typeof node.value !== "string") return;
    for (const delimiter of JINJA) if (delimiter.pattern.test(node.value)) templates.push({ path, delimiter: delimiter.name });
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) => inspectYamlValue(item, `${path}[${index}]`, templates));
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw new Error("Unsupported YAML map key in repository metadata.");
      inspectYamlValue(pair.value, yamlPath(path, pair.key.value), templates);
    }
    return;
  }
  throw new Error("Unsupported YAML feature in repository metadata.");
}

/**
 * Parses YAML front matter with YAML's non-executing core schema. Tags,
 * anchors, aliases, and non-string map keys fail closed before traversal.
 */
export function inspectConfigsFrontMatter(readme) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readme);
  if (!match) return { hasConfigs: false, templates: [] };
  const document = parseDocument(match[1], { schema: "core", strict: true, uniqueKeys: true, maxAliasCount: 0 });
  if (document.errors.length) throw new Error("Malformed YAML front matter.");
  rejectUnsafeYaml(document.contents);
  if (!isMap(document.contents)) throw new Error("Unsupported YAML front matter root.");
  const configs = document.contents.items.find(pair => isScalar(pair.key) && pair.key.value === "configs");
  if (!configs) return { hasConfigs: false, templates: [] };
  const templates = [];
  inspectYamlValue(configs.value, "README.md → configs", templates);
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
      findings.push(finding("high", "Custom model code", mapping.path, `${cross}: ${mapping.value}${named}`, "Current Transformers requires the explicit trust_remote_code=True opt-in to execute custom AutoClass code.", "Inspect the named code before explicitly opting in, and pin the loading call's revision to the resolved commit.", OFFICIAL.transformers));
    }
  }
  if (type === "dataset") {
    const repoName = repoId.split("/")[1];
    const loader = `${repoName}.py`;
    if (tree.has(loader)) findings.push(finding("high", "Legacy dataset loading script", loader, "Root-level dataset loading script present.", "In legacy Datasets v3.4, repository code ran only when load_dataset(..., trust_remote_code=True) was explicitly opted into.", "For that legacy call, use supported data files without remote code, or inspect the script and pin the resolved commit before explicitly opting in.", OFFICIAL.datasets));
    if (readme) for (const hit of inspectConfigsFrontMatter(readme).templates) {
      findings.push(finding("neutral", "Template-like syntax in dataset configuration", hit.path, hit.delimiter, "Current YAML builder parameters work without custom code, and no current standard Hugging Face loading call is documented to render these delimiters.", "Manually review this metadata as needed; this signal does not indicate code execution or a pinning requirement.", OFFICIAL.configs));
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
  findings.sort((a, b) => ({ high: 0, medium: 1, low: 2, neutral: 3 }[a.severity] - ({ high: 0, medium: 1, low: 2, neutral: 3 }[b.severity])));
  const top = findings[0];
  const hasCustomModelCode = findings.some(item => item.name === "Custom model code");
  const hasLegacyDatasetScript = findings.some(item => item.name === "Legacy dataset loading script");
  const hasOnlyTemplateSignal = findings.some(item => item.name === "Template-like syntax in dataset configuration") && findings.every(item => item.name === "Template-like syntax in dataset configuration");
  const verdict = hasCustomModelCode ? "Custom model code can run only when a current Transformers load explicitly opts into trust_remote_code=True."
    : hasLegacyDatasetScript ? "In legacy Datasets v3.4, repository code ran only when load_dataset(..., trust_remote_code=True) was explicitly opted into."
    : hasOnlyTemplateSignal ? "Template-like dataset metadata needs manual review; it is not a code-execution or pinning verdict."
    : top?.severity === "high" ? "Repository code can run when this repo is loaded."
    : top?.name === "Pickle-capable weights" ? "Loading may deserialize pickle-capable weights."
    : top ? "Pin this repository before loading it."
    : "No covered code-execution signal found at this commit.";
  return { complete: true, verdict, findings, resolvedSha };
}
