import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const fixture = JSON.parse(await readFile("tests/fixtures/hub-success.json", "utf8"));
const root = resolve("dist");
let browser;
let origin;
let server;
const eventRequests = [];
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".gif": "image/gif" };

function respond(res, status, body, headers = {}) {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end(body);
}
function serve(req, res) {
  const url = new URL(req.url, "http://local.test");
  if (url.pathname === "/_events/check-complete.gif") {
    eventRequests.push({ url: req.url, method: req.method, cookie: req.headers.cookie || "", referer: req.headers.referer || "", contentLength: req.headers["content-length"] || "" });
    return respond(res, 204, "");
  }
  const candidate = resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
  if (!candidate.startsWith(root + "/") && candidate !== root) return respond(res, 403, "forbidden");
  readFile(candidate).then(body => respond(res, 200, body, { "content-type": mime[extname(candidate)] || "application/octet-stream" })).catch(() => respond(res, 404, "not found"));
}
async function routeHub(page, { failure } = {}) {
  await page.route("https://huggingface.co/**", route => {
    const url = route.request().url();
    if (failure) return route.fulfill({ status: failure, body: "{}", headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    if (url.includes("/revision/")) return route.fulfill({ status: 200, body: JSON.stringify(fixture.modelInfo), headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    if (url.includes("/tree/")) return route.fulfill({ status: 200, body: JSON.stringify(fixture.modelTree), headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    if (url.endsWith("/config.json")) return route.fulfill({ status: 200, body: JSON.stringify(fixture.modelConfig), headers: { "content-type": "text/plain", "access-control-allow-origin": "*" } });
    throw new Error("Unexpected Hub request " + url);
  });
}
async function freshPage(viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await routeHub(page);
  await page.goto(origin, { waitUntil: "networkidle" });
  return { context, page };
}

before(async () => {
  await mkdir("evidence", { recursive: true });
  server = createServer(serve);
  await new Promise(resolveServer => server.listen(0, "127.0.0.1", resolveServer));
  origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
});
after(async () => {
  await browser?.close();
  await new Promise(resolveServer => server?.close(resolveServer));
});

test("desktop stranger path renders a supported verdict, accessible metadata, brand tokens, and one private beacon", async () => {
  eventRequests.length = 0;
  const { context, page } = await freshPage({ width: 1600, height: 1000 });
  try {
    for (let index = 0; index < 4; index += 1) await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "repo");
    await page.keyboard.type("org/repo");
    await page.getByRole("button", { name: "Check repository" }).click();
    await page.getByRole("heading", { name: "Pin this repository before loading it." }).waitFor();
    assert.match(await page.locator("#results").innerText(), /Repository\s+org\/repo[\s\S]*Resolved commit\s+0123456789abcdef0123456789abcdef01234567[\s\S]*Scan complete\s+Yes/);
    assert.equal(await page.locator("#status").getAttribute("aria-live"), "polite");
    const computed = await page.evaluate(() => {
      const css = getComputedStyle(document.body);
      const privacy = getComputedStyle(document.querySelector(".privacy"));
      const title = getComputedStyle(document.querySelector("h1"));
      const y = [...document.querySelectorAll("h1,.intro,.panel,#status,#results,.privacy,.limitation")].map(node => node.getBoundingClientRect().top);
      return { background: css.backgroundColor, color: css.color, bodyFont: css.fontFamily, titleFont: title.fontFamily, privacySize: privacy.fontSize, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, y };
    });
    assert.deepEqual({ background: computed.background, color: computed.color, privacySize: computed.privacySize }, { background: "rgb(247, 244, 234)", color: "rgb(23, 48, 36)", privacySize: "16px" });
    assert.match(computed.bodyFont, /IBM Plex Sans/);
    assert.match(computed.titleFont, /Fraunces/);
    assert.ok(computed.scrollWidth <= computed.viewport);
    assert.ok(computed.y.every((value, index) => index === 0 || value >= computed.y[index - 1]));
    await page.screenshot({ path: "evidence/loadcheck-desktop.png", fullPage: true });
    await page.waitForTimeout(50);
    assert.deepEqual(eventRequests, [{ url: "/_events/check-complete.gif", method: "GET", cookie: "", referer: "", contentLength: "" }]);
  } finally { await context.close(); }
});

test("mobile layout has no horizontal clipping and untrusted input is inserted as text after an incomplete terminal result", async () => {
  eventRequests.length = 0;
  const { context, page } = await freshPage({ width: 390, height: 844 });
  try {
    await page.locator("#repo").fill("<img src=x onerror=window.__loadcheckXss=1>/repo");
    await page.getByRole("button", { name: "Check repository" }).click();
    await page.getByRole("heading", { name: "Loadcheck could not complete this check." }).waitFor();
    assert.equal(await page.evaluate(() => window.__loadcheckXss), undefined);
    assert.equal(await page.locator("#results img").count(), 0);
    assert.match(await page.locator("#results").innerText(), /Scan complete\s+No/);
    const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, bodySize: getComputedStyle(document.body).fontSize, h1Right: document.querySelector("h1").getBoundingClientRect().right }));
    assert.equal(layout.bodySize, "16px");
    assert.ok(layout.scrollWidth <= layout.viewport);
    assert.ok(layout.h1Right <= layout.viewport);
    await page.screenshot({ path: "evidence/loadcheck-mobile.png", fullPage: true });
    await page.waitForTimeout(50);
    assert.deepEqual(eventRequests, [{ url: "/_events/check-complete.gif", method: "GET", cookie: "", referer: "", contentLength: "" }]);
  } finally { await context.close(); }
});

test("a mocked Hub HTTP failure renders required incomplete metadata and a single no-payload beacon", async () => {
  eventRequests.length = 0;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await routeHub(page, { failure: 429 });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator("#repo").fill("org/repo");
    await page.locator("#revision").fill("release/1");
    await page.getByRole("button", { name: "Check repository" }).click();
    await page.getByRole("heading", { name: "Loadcheck could not complete this check." }).waitFor();
    assert.match(await page.locator("#results").innerText(), /Repository\s+org\/repo[\s\S]*Type\s+model[\s\S]*Requested revision\s+release\/1[\s\S]*Resolved commit\s+Not resolved[\s\S]*Checked \(UTC\)[\s\S]*Scan complete\s+No/);
    await page.waitForTimeout(50);
    assert.deepEqual(eventRequests, [{ url: "/_events/check-complete.gif", method: "GET", cookie: "", referer: "", contentLength: "" }]);
  } finally { await context.close(); }
});
