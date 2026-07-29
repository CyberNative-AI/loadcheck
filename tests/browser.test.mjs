import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("the browser entrypoint has an accessible form, live status, and a strict CSP", async () => {
  const page = await readFile("dist/index.html", "utf8");
  const css = await readFile("dist/assets/styles.css", "utf8");
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /<label for="repo">Model or dataset ID/);
  assert.match(page, /Content-Security-Policy[\s\S]*connect-src 'self' https:\/\/huggingface\.co/);
  assert.match(css, /font: 400 16px\/1\.6/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 640px\)/);
});
