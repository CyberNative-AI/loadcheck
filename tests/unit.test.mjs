import assert from "node:assert/strict";
import test from "node:test";
import { analyze, inspectConfigsFrontMatter } from "../dist/assets/analyze.js";
import { parseRepository } from "../dist/assets/hub.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const base = (changes = {}) => ({ repoId: "org/repo", type: "model", requestedRevision: SHA, resolvedSha: SHA, paths: ["config.json", "model.safetensors"], config: {}, ...changes });

test("a built-in safetensors model at a full SHA has no covered signal", () => {
  assert.equal(analyze(base()).verdict, "No covered code-execution signal found at this commit.");
});
test("an omitted revision is an unpinned verdict", () => {
  const result = analyze(base({ requestedRevision: "" }));
  assert.equal(result.verdict, "Pin this repository before loading it.");
  assert.equal(result.findings[0].name, "Unpinned revision");
});
test("a confirmed local auto_map mapping is custom-code evidence", () => {
  const result = analyze(base({ paths: ["config.json", "modeling_foo.py"], config: { auto_map: { AutoModelForCausalLM: "modeling_foo.Foo" } } }));
  assert.equal(result.verdict, "Repository code can run when this repo is loaded.");
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
  assert.equal(result.findings[0].path, "repo.py");
});
test("ordinary dataset config globs do not become template findings", () => {
  const readme = "---\nconfigs:\n- config_name: default\n  data_files: data/*.csv\n  builder_name: csv\n---\n# Dataset";
  assert.equal(analyze(base({ type: "dataset", readme, paths: ["README.md"] })).findings.length, 0);
});
test("all Jinja delimiter classes below configs are flagged with a path", () => {
  const readme = "---\nconfigs:\n- data_files: '{{ files }}'\n  note: '{% if x %}'\n  comment: '{# note #}'\n---";
  const result = analyze(base({ type: "dataset", readme, paths: ["README.md"] }));
  assert.equal(result.findings.filter(item => item.name.includes("Template")).length, 3);
  assert.match(result.findings[0].path, /^README\.md → configs\[0\]/);
});
test("malformed YAML fails closed", () => {
  assert.throws(() => inspectConfigsFrontMatter("---\nconfigs:\n- value: [broken\n---"), /Malformed/);
});
test("repository parsing permits canonical HF URLs and rejects unsafe inputs", () => {
  assert.equal(parseRepository("https://huggingface.co/datasets/org/repo"), "org/repo");
  for (const value of ["<script>x</script>/repo", "https://evil.example/org/repo", "org/repo?x=y", "org%2Frepo"]) assert.throws(() => parseRepository(value));
});
