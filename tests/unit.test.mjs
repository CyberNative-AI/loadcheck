import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { analyze, inspectConfigsFrontMatter } from "../dist/assets/analyze.js";
import { HubError, MAX_TEXT_BYTES, parseRepository, parseRevision, scanHub } from "../dist/assets/hub.js";

const fixture = JSON.parse(await readFile("tests/fixtures/hub-success.json", "utf8"));
const SHA = fixture.sha;
const base = (changes = {}) => ({ repoId: "org/repo", type: "model", requestedRevision: SHA, resolvedSha: SHA, paths: ["config.json", "model.safetensors"], config: {}, ...changes });
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
const text = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/plain", ...extra } });

async function withFetch(handler, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await callback(); } finally { globalThis.fetch = original; }
}
function hubFetch({ info = fixture.modelInfo, tree = fixture.modelTree, config = fixture.modelConfig, readme = fixture.datasetReadme, treeHeaders = {} } = {}, calls = []) {
  return async url => {
    const target = String(url); calls.push(target);
    if (target.includes("/revision/")) return json(info);
    if (target.includes("/tree/")) return json(tree, 200, treeHeaders);
    if (target.endsWith("/config.json")) return config instanceof Response ? config : text(typeof config === "string" ? config : JSON.stringify(config));
    if (target.endsWith("/README.md")) return text(readme);
    throw new Error("Unexpected Hub URL " + target);
  };
}
async function scanWith(handler, input = {}) {
  return withFetch(handler, () => scanHub({ repoId: "org/repo", type: "model", revision: SHA, ...input }));
}
async function expectHubError(handler, code, input) {
  await assert.rejects(() => scanWith(handler, input), error => error instanceof HubError && error.code === code && error.context?.complete === false);
}

test("a built-in safetensors model at a full SHA has no covered signal", () => {
  assert.equal(analyze(base()).verdict, "No covered code-execution signal found at this commit.");
});
test("an omitted revision is an unpinned verdict", () => {
  const result = analyze(base({ requestedRevision: "" }));
  assert.equal(result.verdict, "Pin this repository before loading it.");
  assert.equal(result.findings[0].name, "Unpinned revision");
  assert.equal(result.findings[0].source, "https://huggingface.co/docs/transformers/models");
});
test("a confirmed local auto_map mapping is custom-code evidence", () => {
  const result = analyze(base({ paths: ["config.json", "modeling_foo.py"], config: { auto_map: { AutoModelForCausalLM: "modeling_foo.Foo" } } }));
  assert.equal(result.verdict, "Custom model code can run only when a current Transformers load explicitly opts into trust_remote_code=True.");
  assert.match(result.findings[0].trigger, /explicit trust_remote_code=True opt-in/);
  assert.equal(result.findings[0].source, "https://huggingface.co/docs/transformers/model_doc/auto");
  assert.match(result.findings[0].observed, /modeling_foo\.py/);
});
test("a cross-repository auto_map mapping does not invent a file", () => {
  const result = analyze(base({ config: { auto_map: { AutoModel: "other/repo--modeling_foo.Foo" } } }));
  assert.match(result.findings[0].observed, /cross-repository/);
  assert.doesNotMatch(result.findings[0].observed, /confirmed local/);
});
test("pickle-capable paths without safetensors produce the pickle verdict", () => {
  assert.equal(analyze(base({ paths: ["pytorch_model.bin"] })).verdict, "Loading may deserialize pickle-capable weights.");
});
test("a safetensors path suppresses the pickle-only signal", () => {
  assert.equal(analyze(base({ paths: ["pytorch_model.bin", "alternate/model.safetensors"] })).verdict, "No covered code-execution signal found at this commit.");
});
test("a root dataset loading script is a code-execution signal", () => {
  const result = analyze(base({ type: "dataset", paths: ["repo.py", "other.py"] }));
  assert.equal(result.verdict, "In legacy Datasets v3.4, repository code ran only when load_dataset(..., trust_remote_code=True) was explicitly opted into.");
  assert.equal(result.findings[0].name, "Legacy dataset loading script");
  assert.match(result.findings[0].trigger, /legacy Datasets v3.4.*explicitly opted into/);
  assert.equal(result.findings[0].source, "https://huggingface.co/docs/datasets/v3.4.0/en/dataset_script");
  assert.equal(result.findings[0].path, "repo.py");
});
test("ordinary dataset config globs do not become template findings", () => {
  const readme = fixture.datasetReadme;
  assert.equal(analyze(base({ type: "dataset", readme, paths: ["README.md"] })).findings.length, 0);
});
test("all Jinja delimiter classes below nested configs are flagged with exact paths", async () => {
  const readme = await readFile("tests/fixtures/readme-jinja.yml", "utf8");
  const result = analyze(base({ type: "dataset", readme, paths: ["README.md"] }));
  const findings = result.findings.filter(item => item.name.includes("Template"));
  assert.equal(findings.length, 3);
  assert.equal(result.verdict, "Template-like dataset metadata needs manual review; it is not a code-execution or pinning verdict.");
  assert.ok(findings.every(item => item.severity === "neutral"));
  assert.ok(findings.every(item => item.source === "https://huggingface.co/docs/hub/en/datasets-manual-configuration"));
  assert.deepEqual(findings.map(item => item.path), [
    "README.md → configs[0].nested.expression",
    "README.md → configs[0].nested.statement",
    "README.md → configs[0].nested.comment"
  ]);
});
test("an unpinned revision remains the top-level verdict alongside template metadata", async () => {
  const readme = await readFile("tests/fixtures/readme-jinja.yml", "utf8");
  const result = analyze(base({ type: "dataset", requestedRevision: "", readme, paths: ["README.md"] }));
  assert.equal(result.verdict, "Pin this repository before loading it.");
  const unpinned = result.findings.find(item => item.name === "Unpinned revision");
  assert.ok(unpinned);
  assert.equal(unpinned.source, "https://huggingface.co/docs/transformers/models");
  const templates = result.findings.filter(item => item.name === "Template-like syntax in dataset configuration");
  assert.equal(templates.length, 3);
  assert.ok(templates.every(item => item.severity === "neutral"));
  assert.ok(templates.every(item => item.source === "https://huggingface.co/docs/hub/en/datasets-manual-configuration"));
});
test("unsafe or malformed YAML fails closed", async () => {
  const malformed = await readFile("tests/fixtures/malformed-readme.yml", "utf8");
  assert.throws(() => inspectConfigsFrontMatter(malformed), /Malformed/);
  assert.throws(() => inspectConfigsFrontMatter("---\nconfigs:\n- value: !unsafe x\n---\n"), /Unsupported/);
});
test("nested and flow-style configs report exact template paths", async () => {
  const nested = await readFile("tests/fixtures/readme-nested-jinja.yml", "utf8");
  const flow = await readFile("tests/fixtures/readme-flow-jinja.yml", "utf8");
  assert.deepEqual(inspectConfigsFrontMatter(nested).templates, [{ path: "README.md → configs[0].data_files[0].path", delimiter: "expression delimiter" }]);
  assert.deepEqual(inspectConfigsFrontMatter(flow).templates, [{ path: "README.md → configs[0].data_files", delimiter: "expression delimiter" }]);
});
test("unsafe YAML tags and aliases fail closed before a complete dataset scan", async () => {
  for (const file of ["readme-unsafe-tag.yml", "readme-unsafe-alias.yml"]) {
    const readme = await readFile("tests/fixtures/" + file, "utf8");
    await expectHubError(hubFetch({ info: fixture.datasetInfo, tree: fixture.datasetTree, readme }), "parse", { type: "dataset" });
  }
});
test("repository and revision parsing accepts supported forms and rejects unsafe or pull-request forms", () => {
  assert.equal(parseRepository("https://huggingface.co/datasets/org/repo"), "org/repo");
  assert.equal(parseRevision("release/1.0"), "release/1.0");
  for (const value of ["<script>x</script>/repo", "https://evil.example/org/repo", "org/repo?x=y", "org%2Frepo"]) assert.throws(() => parseRepository(value));
  for (const value of ["refs/pull/12/head", "pr/12", "pull/12", "main?x=1", "x".repeat(129)]) assert.throws(() => parseRevision(value));
});
test("Hub success binds all reads to the resolved SHA and skips README without configs metadata", async () => {
  const calls = [];
  const scan = await scanWith(hubFetch({}, calls));
  assert.equal(scan.resolvedSha, SHA);
  assert.ok(calls.some(url => url.includes("/api/models/org/repo/revision/")));
  assert.equal(calls.some(url => url.includes("org%2Frepo")), false);
  assert.ok(calls.every(url => !url.includes("/resolve/") || url.includes("/resolve/" + SHA + "/")));
  const datasetCalls = [];
  await scanWith(hubFetch({ info: { sha: SHA, cardData: {} }, tree: [{ path: "README.md" }] }, datasetCalls), { type: "dataset" });
  assert.equal(datasetCalls.some(url => url.endsWith("/README.md")), false);
});
test("malformed JSON, oversized text, oversized tree, and bad pagination fail closed", async () => {
  const badJson = await readFile("tests/fixtures/malformed-config.json", "utf8");
  await expectHubError(hubFetch({ tree: [{ path: "config.json" }], config: badJson }), "parse");
  await expectHubError(hubFetch({ tree: [{ path: "config.json" }], config: text("x", 200, { "content-length": String(MAX_TEXT_BYTES + 1) }) }), "size");
  await expectHubError(hubFetch({ tree: Array.from({ length: 10001 }, (_, index) => ({ path: "x" + index })) }), "size");
  await expectHubError(hubFetch({ treeHeaders: { link: "<https://huggingface.co/api/models/org%2Frepo/tree/not-the-sha?cursor=x>; rel=\"next\"" } }), "pagination");
});
test("HTTP, timeout, and CORS-style failures fail closed with distinct error classes", async () => {
  for (const [status, code] of [[404, "missing"], [403, "forbidden"], [429, "rate"], [500, "server"]]) {
    await expectHubError(async () => json({}, status), code);
  }
  await expectHubError(async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; }, "timeout");
  await expectHubError(async () => { throw new TypeError("Failed to fetch"); }, "network");
});
test("README parse failures and resolved-SHA pagination URLs fail closed", async () => {
  const malformed = await readFile("tests/fixtures/malformed-readme.yml", "utf8");
  await expectHubError(hubFetch({ info: fixture.datasetInfo, tree: fixture.datasetTree, readme: malformed }), "parse", { type: "dataset" });
  await expectHubError(hubFetch({ treeHeaders: { link: "<https://huggingface.co/api/models/org%2Frepo/tree/ffffffffffffffffffffffffffffffffffffffff?cursor=x>; rel=\"next\"" } }), "pagination");
});
