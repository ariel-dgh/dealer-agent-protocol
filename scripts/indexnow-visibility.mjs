#!/usr/bin/env node
/**
 * Fail-soft IndexNow ping for dealeraivisibility.com only.
 *
 * Runs after `npm run deploy:visibility` succeeds. Network errors, bad refs,
 * and rejected pings are logged and never fail the deploy (exit 0).
 * `--sync-assets` is the pre-deploy copy of this site's src into dist and
 * may exit 1 if that copy fails.
 *
 * Changed URLs come from --urls, or from a git diff of
 * dealer-ai-visibility-site/src since --since / VISIBILITY_DEPLOYED_REF /
 * dealer-ai-visibility-site/.last-deployed-ref. Sitemap URLs are used only
 * with --from-sitemap. --dry-run prints the JSON payload and does not POST.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "dealer-ai-visibility-site", "src");
const DIST = path.join(ROOT, "dealer-ai-visibility-site", "dist");
const BASELINE = path.join(ROOT, "dealer-ai-visibility-site", ".last-deployed-ref");
const SRC_PREFIX = "dealer-ai-visibility-site/src/";
export const HOST = "dealeraivisibility.com";
export const ORIGIN = `https://${HOST}`;
export const MAX_URLS = 10_000;
const ENDPOINT = "https://api.indexnow.org/indexnow";

export function selectUrls(inputs) {
  const seen = new Set();
  const accepted = [];
  for (const input of inputs) {
    let url;
    try {
      url = new URL(input);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    if (url.hostname === `www.${HOST}`) url.hostname = HOST;
    if (url.hostname !== HOST) continue;
    url.hash = "";
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    accepted.push(normalized);
    if (accepted.length >= MAX_URLS) break;
  }
  return accepted;
}

function isNoindex(html) {
  return [...html.matchAll(/<meta\b[^>]*>/gi)].some((match) => /\brobots\b/i.test(match[0]) && /\bnoindex\b/i.test(match[0]));
}

export function urlForRepoPath(repoPath) {
  const normalized = String(repoPath).replaceAll("\\", "/");
  if (!normalized.startsWith(SRC_PREFIX)) return null;
  const relative = normalized.slice(SRC_PREFIX.length);
  if (!relative || relative.endsWith("/") || relative === "404.html" || relative.endsWith("/404.html")) return null;
  if (relative.endsWith(".html")) {
    const html = readFileSync(path.join(ROOT, normalized), "utf8");
    if (isNoindex(html)) return null;
    if (relative === "index.html") return `${ORIGIN}/`;
    if (relative.endsWith("/index.html")) return `${ORIGIN}/${relative.slice(0, -"index.html".length)}`;
    return `${ORIGIN}/${relative}`;
  }
  if (relative.includes("/")) return null;
  if (/^(robots\.txt|sitemap\.xml|llms\.txt|[a-f0-9]{32}\.txt)$/.test(relative)) return `${ORIGIN}/${relative}`;
  return null;
}

export function readIndexNowKey(directory = SRC) {
  const matches = readdirSync(directory)
    .filter((name) => /^[a-f0-9]{32}\.txt$/.test(name))
    .filter((name) => readFileSync(path.join(directory, name), "utf8").replace(/^\uFEFF/, "").trim() === name.slice(0, -4));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? "IndexNow key file not found in dealer-ai-visibility-site/src"
      : "multiple IndexNow key files found");
  }
  return matches[0].slice(0, -4);
}

export function urlsFromSitemap(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]);
}

export function buildPayload(key, urls) {
  return { host: HOST, key, keyLocation: `${ORIGIN}/${key}.txt`, urlList: selectUrls(urls) };
}

function parseArgs(argv) {
  const args = { dryRun: false, fromSitemap: false, updateBaseline: false, syncAssets: false, since: "", urls: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--from-sitemap") args.fromSitemap = true;
    else if (token === "--update-baseline") args.updateBaseline = true;
    else if (token === "--sync-assets") args.syncAssets = true;
    else if (token === "--since") args.since = argv[++index] || "";
    else if (token === "--urls") {
      while (argv[index + 1] && !argv[index + 1].startsWith("--")) args.urls.push(argv[++index]);
    } else if (token.startsWith("--urls=")) args.urls.push(...token.slice("--urls=".length).split(",").filter(Boolean));
    else throw new Error(`unknown argument ${token}`);
  }
  return args;
}

function gitLines(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveSince(args) {
  if (args.since) return args.since;
  const fromEnv = (process.env.VISIBILITY_DEPLOYED_REF || "").trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(BASELINE)) return "";
  return readFileSync(BASELINE, "utf8").trim();
}

function changedUrls(since) {
  const tracked = gitLines(["diff", "--name-only", "--diff-filter=ACMR", since, "--", "dealer-ai-visibility-site/src"]);
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard", "--", "dealer-ai-visibility-site/src"]);
  return [...new Set([...tracked, ...untracked])].map((file) => urlForRepoPath(file)).filter(Boolean);
}

function writeBaseline() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  writeFileSync(BASELINE, `${sha}\n`);
  console.error(`indexnow: recorded deployed ref ${sha}`);
}

function syncVisibilityDist() {
  rmSync(DIST, { recursive: true, force: true });
  cpSync(SRC, DIST, { recursive: true });
  console.error("indexnow: copied dealer-ai-visibility-site/src to dist");
}

async function submit(args) {
  const key = readIndexNowKey();
  let rawUrls = [];
  if (args.urls.length) rawUrls = args.urls;
  else if (args.fromSitemap) rawUrls = urlsFromSitemap(readFileSync(path.join(SRC, "sitemap.xml"), "utf8"));
  else {
    const since = resolveSince(args);
    if (!since) {
      console.error("indexnow: no deployed ref. Pass --since <ref>, --urls <url>, or --from-sitemap. Skipping ping.");
      if (args.dryRun) process.stdout.write(`${JSON.stringify(buildPayload(key, []), null, 2)}\n`);
      return;
    }
    rawUrls = changedUrls(since);
  }
  const payload = buildPayload(key, rawUrls);
  if (payload.urlList.length !== rawUrls.length) {
    console.error(`indexnow: kept ${payload.urlList.length} dealeraivisibility.com URL(s); dropped or capped the rest (max ${MAX_URLS}).`);
  }
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (!payload.urlList.length) {
    console.error("indexnow: no dealeraivisibility.com URLs to submit.");
    if (args.updateBaseline) writeBaseline();
    return;
  }
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Accept: "application/json, text/plain", "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  console.log(`indexnow: status ${response.status} for ${payload.urlList.length} URL(s).`);
  if (body.trim()) console.log(body.slice(0, 500));
  if (!args.updateBaseline) return;
  if (response.status === 200 || response.status === 202) writeBaseline();
  else console.error("indexnow: baseline not moved because the ping was not accepted.");
}

function isDirectRun() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.syncAssets) syncVisibilityDist();
  const syncOnly = args.syncAssets && !args.dryRun && !args.fromSitemap && !args.updateBaseline && !args.since && args.urls.length === 0;
  if (syncOnly) return 0;
  try {
    await submit(args);
  } catch (error) {
    console.error(`indexnow: ${error instanceof Error ? error.message : error}`);
  }
  return 0;
}

if (isDirectRun()) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`indexnow: ${error instanceof Error ? error.message : error}`);
      const syncOnly = process.argv.includes("--sync-assets") && !process.argv.includes("--dry-run") && !process.argv.includes("--from-sitemap");
      process.exit(syncOnly ? 1 : 0);
    });
}
