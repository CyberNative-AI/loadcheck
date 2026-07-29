import { FULL_SHA } from "./analyze.js";

const API = "https://huggingface.co";
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 10000;
const TIMEOUT_MS = 12000;

export class HubError extends Error { constructor(message, code = "network") { super(message); this.code = code; } }

export function parseRepository(value) {
  const raw = value.trim();
  if (raw.length > 192 || !raw) throw new HubError("Enter a public namespace/name repository ID.", "input");
  if (/%2f|%5c/i.test(raw) || /[?#\\]/.test(raw) || raw.includes("..")) throw new HubError("Repository ID contains an unsupported path component.", "input");
  let id = raw;
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "huggingface.co" || url.username || url.password || url.search || url.hash) throw new HubError("Use a public Hugging Face model or dataset URL without parameters.", "input");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "datasets") parts.shift();
    if (parts.length !== 2) throw new HubError("Use a repository URL, not a file or revision URL.", "input");
    id = parts.join("/");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id)) throw new HubError("Use namespace/name with letters, digits, dots, underscores, or hyphens.", "input");
  return id;
}

async function request(url, kind = "json") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "omit", headers: { Accept: kind === "json" ? "application/json" : "text/plain" } });
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? "forbidden" : response.status === 404 ? "missing" : response.status === 429 ? "rate" : response.status >= 500 ? "server" : "http";
      throw new HubError(`Hugging Face returned ${response.status}.`, code);
    }
    const contentType = response.headers.get("content-type") || "";
    if (kind !== "text" && !contentType.includes("json")) throw new HubError("Hugging Face returned an unexpected response type.", "parse");
    if (kind === "text") {
      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_TEXT_BYTES) throw new HubError("Repository text file exceeds the 1 MiB limit.", "size");
      const reader = response.body?.getReader(); let bytes = 0; const chunks = [];
      if (!reader) throw new HubError("Hugging Face returned no readable response.", "parse");
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_TEXT_BYTES) throw new HubError("Repository text file exceeds the 1 MiB limit.", "size"); chunks.push(value); }
      return new TextDecoder().decode(new Blob(chunks));
    }
    const data = await response.json();
    return kind === "tree" ? { data, link: response.headers.get("link") } : data;
  } catch (error) {
    if (error instanceof HubError) throw error;
    if (error?.name === "AbortError") throw new HubError("Request timed out.", "timeout");
    throw new HubError("Browser could not reach Hugging Face (possibly CORS or network failure).", "network");
  } finally { clearTimeout(timer); }
}

function typePath(type) { return type === "dataset" ? "datasets" : "models"; }
function resolveUrl(type, id, revision) { return `${API}/api/${typePath(type)}/${encodeURIComponent(id)}/revision/${encodeURIComponent(revision || "main")}`; }
function rawUrl(type, id, sha, path) { return `${API}/${type === "dataset" ? "datasets/" : ""}${id}/resolve/${sha}/${path}`; }
function nextPage(link) {
  const match = /<([^>]+)>;\s*rel="next"/.exec(link || "");
  if (!match) return null;
  const url = new URL(match[1], API);
  if (url.origin !== API || !url.pathname.startsWith("/api/")) throw new HubError("Repository tree pagination response was invalid.", "pagination");
  return url.toString();
}


export async function scanHub({ repoId: rawId, type, revision }) {
  const repoId = parseRepository(rawId);
  const info = await request(resolveUrl(type, repoId, revision));
  const resolvedSha = info?.sha;
  if (!FULL_SHA.test(resolvedSha || "")) throw new HubError("Hugging Face did not return a full commit SHA.", "parse");
  const base = `${API}/api/${typePath(type)}/${encodeURIComponent(repoId)}/tree/${resolvedSha}?recursive=true&expand=false&limit=1000`;
  const paths = []; let next = base;
  while (next) {
    const response = await request(next, "tree");
    if (!Array.isArray(response.data)) throw new HubError("Repository tree response was invalid.", "parse");
    for (const item of response.data) { if (typeof item?.path !== "string") throw new HubError("Repository tree entry was invalid.", "parse"); paths.push(item.path); if (paths.length > MAX_TREE_ENTRIES) throw new HubError("Repository tree exceeds the 10,000-file limit.", "size"); }
    next = nextPage(response.link);
  }
  let config; let readme;
  if (type === "model" && paths.includes("config.json")) { const text = await request(rawUrl(type, repoId, resolvedSha, "config.json"), "text"); try { config = JSON.parse(text); } catch { throw new HubError("config.json could not be parsed.", "parse"); } }
  if (type === "dataset" && paths.includes("README.md")) readme = await request(rawUrl(type, repoId, resolvedSha, "README.md"), "text");
  return { repoId, type, requestedRevision: revision || "", resolvedSha, paths, config, readme };
}
