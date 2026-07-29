import { FULL_SHA, inspectConfigsFrontMatter } from "./analyze.js";

const API = "https://huggingface.co";
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_TREE_ENTRIES = 10000;
const TIMEOUT_MS = 12000;

export class HubError extends Error {
  constructor(message, code = "network") { super(message); this.code = code; }
}

export function parseRepository(value) {
  const raw = value.trim();
  if (raw.length > 192 || !raw) throw new HubError("Enter a public namespace/name repository ID.", "input");
  if (/%2f|%5c/i.test(raw) || /[?#\\]/.test(raw) || raw.includes("..")) throw new HubError("Repository ID contains an unsupported path component.", "input");
  let id = raw;
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new HubError("Use a public Hugging Face model or dataset URL without parameters.", "input"); }
    if (url.protocol !== "https:" || url.hostname !== "huggingface.co" || url.username || url.password || url.search || url.hash) throw new HubError("Use a public Hugging Face model or dataset URL without parameters.", "input");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "datasets") parts.shift();
    if (parts.length !== 2) throw new HubError("Use a repository URL, not a file or revision URL.", "input");
    id = parts.join("/");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id)) throw new HubError("Use namespace/name with letters, digits, dots, underscores, or hyphens.", "input");
  return id;
}

export function parseRevision(value = "") {
  const revision = value.trim();
  if (!revision) return "";
  if (revision.length > 128 || /[%?#\\\s]/.test(revision) || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(revision)) throw new HubError("Revision contains unsupported characters.", "input");
  if (/(^|\/)(?:pr|pull)(?:\/|$)/i.test(revision) || /^refs\/pull\//i.test(revision)) throw new HubError("Pull-request revisions are not supported.", "input");
  return revision;
}

async function readBounded(response) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_TEXT_BYTES) throw new HubError("Repository response exceeds the 1 MiB limit.", "size");
  const reader = response.body?.getReader();
  if (!reader) throw new HubError("Hugging Face returned no readable response.", "parse");
  let bytes = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_TEXT_BYTES) throw new HubError("Repository response exceeds the 1 MiB limit.", "size");
    chunks.push(value);
  }
  return new Response(new Blob(chunks)).text();
}

async function request(url, kind = "json") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "omit", mode: "cors", headers: { Accept: kind === "text" ? "text/plain" : "application/json" } });
    if (response.url && new URL(response.url).origin !== API) throw new HubError("Hugging Face redirected outside the allowed API origin.", "network");
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? "forbidden" : response.status === 404 ? "missing" : response.status === 429 ? "rate" : response.status >= 500 ? "server" : "http";
      throw new HubError("Hugging Face returned " + response.status + ".", code);
    }
    const contentType = response.headers.get("content-type") || "";
    if (kind !== "text" && !/application\/(?:[a-z.+-]*\+)?json/i.test(contentType)) throw new HubError("Hugging Face returned an unexpected response type.", "parse");
    const text = await readBounded(response);
    if (kind === "text") return text;
    let data;
    try { data = JSON.parse(text); } catch { throw new HubError("Hugging Face returned malformed JSON.", "parse"); }
    return kind === "tree" ? { data, link: response.headers.get("link") } : data;
  } catch (error) {
    if (error instanceof HubError) throw error;
    if (error?.name === "AbortError") throw new HubError("Request timed out.", "timeout");
    throw new HubError("Browser could not reach Hugging Face (possibly CORS or network failure).", "network");
  } finally { clearTimeout(timer); }
}

function typePath(type) { return type === "dataset" ? "datasets" : "models"; }
function resolveUrl(type, id, revision) { return API + "/api/" + typePath(type) + "/" + id + "/revision/" + encodeURIComponent(revision || "main"); }
function rawUrl(type, id, sha, path) { return API + "/" + (type === "dataset" ? "datasets/" : "") + id + "/resolve/" + sha + "/" + path; }
function nextPage(link, treeUrl) {
  const match = /<([^>]+)>;\s*rel="next"/.exec(link || "");
  if (!match) return null;
  const url = new URL(match[1], API);
  const expected = new URL(treeUrl);
  if (url.origin !== API || url.pathname !== expected.pathname) throw new HubError("Repository tree pagination response was invalid.", "pagination");
  return url.toString();
}
function hasConfigsMetadata(info) {
  return Boolean(info?.cardData && Object.prototype.hasOwnProperty.call(info.cardData, "configs"));
}

export async function scanHub({ repoId: rawId, type, revision }) {
  let context = { repoId: rawId?.trim?.() || "", type, requestedRevision: revision?.trim?.() || "", resolvedSha: "", complete: false };
  try {
    if (type !== "model" && type !== "dataset") throw new HubError("Choose a supported repository type.", "input");
    const repoId = parseRepository(rawId);
    const requestedRevision = parseRevision(revision || "");
    context = { ...context, repoId, requestedRevision };
    const info = await request(resolveUrl(type, repoId, requestedRevision));
    const resolvedSha = info?.sha;
    if (!FULL_SHA.test(resolvedSha || "")) throw new HubError("Hugging Face did not return a full commit SHA.", "parse");
    context = { ...context, resolvedSha };
    const base = API + "/api/" + typePath(type) + "/" + repoId + "/tree/" + resolvedSha + "?recursive=true&expand=false&limit=1000";
    const paths = []; let next = base;
    while (next) {
      const response = await request(next, "tree");
      if (!Array.isArray(response.data)) throw new HubError("Repository tree response was invalid.", "parse");
      for (const item of response.data) {
        if (typeof item?.path !== "string") throw new HubError("Repository tree entry was invalid.", "parse");
        paths.push(item.path);
        if (paths.length > MAX_TREE_ENTRIES) throw new HubError("Repository tree exceeds the 10,000-file limit.", "size");
      }
      next = nextPage(response.link, base);
    }
    let config; let readme;
    if (type === "model" && paths.includes("config.json")) {
      const text = await request(rawUrl(type, repoId, resolvedSha, "config.json"), "text");
      try { config = JSON.parse(text); } catch { throw new HubError("config.json could not be parsed.", "parse"); }
    }
    if (type === "dataset" && paths.includes("README.md") && hasConfigsMetadata(info)) {
      readme = await request(rawUrl(type, repoId, resolvedSha, "README.md"), "text");
      try { inspectConfigsFrontMatter(readme); } catch { throw new HubError("README.md configuration metadata could not be parsed.", "parse"); }
    }
    return { repoId, type, requestedRevision, resolvedSha, paths, config, readme, complete: true };
  } catch (error) {
    const failure = error instanceof HubError ? error : new HubError("Repository metadata could not be parsed.", "parse");
    failure.context = context;
    throw failure;
  }
}
