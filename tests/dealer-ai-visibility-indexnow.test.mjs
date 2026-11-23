import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST,
  MAX_URLS,
  ORIGIN,
  buildPayload,
  readIndexNowKey,
  selectUrls,
  urlForRepoPath,
} from "../scripts/indexnow-visibility.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runPing(args) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts/indexnow-visibility.mjs"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, VISIBILITY_DEPLOYED_REF: "" },
  });
}

test("IndexNow key file body matches the path the worker serves", () => {
  const key = readIndexNowKey();
  assert.match(key, /^[a-f0-9]{32}$/);
  const body = readFileSync(path.join(ROOT, "dealer-ai-visibility-site/src", `${key}.txt`), "utf8").replace(/^\uFEFF/, "").trim();
  assert.equal(body, key);
  assert.equal(urlForRepoPath(`dealer-ai-visibility-site/src/${key}.txt`), `${ORIGIN}/${key}.txt`);
});

test("visibility asset config does not SPA-fallback the key file", () => {
  for (const name of ["dealer-ai-visibility.wrangler.jsonc", "dealer-ai-visibility.staging.wrangler.jsonc"]) {
    const config = readFileSync(path.join(ROOT, "deployment/cloudflare", name), "utf8");
    assert.match(config, /"not_found_handling": "404-page"/);
    assert.equal(config.includes("single-page-application"), false);
    assert.match(config, /dealer-ai-visibility-site\/dist/);
  }
});

test("sitemap is valid XML and every listed URL exists in the visibility source", () => {
  const xml = readFileSync(path.join(ROOT, "dealer-ai-visibility-site/src/sitemap.xml"), "utf8");
  const parsed = spawnSync("python3", ["-c", `
import sys, xml.etree.ElementTree as ET
from datetime import date
root = ET.fromstring(sys.stdin.read())
ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
if root.tag != ns + "urlset":
    raise SystemExit("sitemap root is not urlset")
found = False
for node in root.findall(ns + "url"):
    loc = node.find(ns + "loc").text.strip()
    date.fromisoformat(node.find(ns + "lastmod").text.strip())
    print(loc)
    found = True
if not found:
    raise SystemExit("sitemap has no urls")
`], { input: xml, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  const locs = parsed.stdout.trim().split("\n");
  assert.ok(locs.includes("https://dealeraivisibility.com/"));
  assert.ok(locs.includes("https://dealeraivisibility.com/methodology/"));
  for (const loc of locs) {
    const url = new URL(loc);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, HOST);
    const relative = url.pathname === "/"
      ? "index.html"
      : url.pathname.endsWith("/")
        ? `${url.pathname.slice(1)}index.html`
        : url.pathname.slice(1);
    assert.equal(existsSync(path.join(ROOT, "dealer-ai-visibility-site/src", relative)), true, loc);
  }
});

test("changed visibility files map to public URLs and skip noindex assets", () => {
  assert.equal(urlForRepoPath("dealer-ai-visibility-site/src/index.html"), "https://dealeraivisibility.com/");
  assert.equal(urlForRepoPath("dealer-ai-visibility-site/src/methodology/index.html"), "https://dealeraivisibility.com/methodology/");
  assert.equal(urlForRepoPath("dealer-ai-visibility-site/src/sitemap.xml"), "https://dealeraivisibility.com/sitemap.xml");
  assert.equal(urlForRepoPath("dealer-ai-visibility-site/src/robots.txt"), "https://dealeraivisibility.com/robots.txt");
  assert.equal(urlForRepoPath("dealer-ai-visibility-site/src/llms.txt"), "https://dealeraivisibility.com/llms.txt");
  assert.equal(urlForRepoPath("dealer-ai-visibility-site/src/unsubscribe/index.html"), null);
  assert.equal(urlForRepoPath("dealer-ai-visibility-site/src/404.html"), null);
  assert.equal(urlForRepoPath("dealer-ai-visibility-site/src/styles.css"), null);
  assert.equal(urlForRepoPath("dealershipmcp-site/src/index.html"), null);
});

test("URL selection stays on the apex host and caps at 10000", () => {
  assert.deepEqual(selectUrls([
    "https://dealeraivisibility.com/methodology/",
    "https://dealeraivisibility.com/methodology/#section",
    "https://www.dealeraivisibility.com/privacy/",
    "http://dealeraivisibility.com/contact/",
    "https://example.com/leaderboards/",
    "not a url",
  ]), [
    "https://dealeraivisibility.com/methodology/",
    "https://dealeraivisibility.com/privacy/",
  ]);
  const capped = selectUrls(Array.from({ length: MAX_URLS + 5 }, (_, index) => `https://dealeraivisibility.com/p/${index}/`));
  assert.equal(capped.length, MAX_URLS);
  const key = "a".repeat(32);
  assert.deepEqual(buildPayload(key, ["https://dealeraivisibility.com/"]), {
    host: HOST,
    key,
    keyLocation: `${ORIGIN}/${key}.txt`,
    urlList: ["https://dealeraivisibility.com/"],
  });
});

test("dry-run prints the IndexNow payload and does not require a network call", () => {
  const explicit = runPing(["--dry-run", "--urls", "https://dealeraivisibility.com/methodology/", "https://example.com/nope", "https://www.dealeraivisibility.com/contact/"]);
  assert.equal(explicit.status, 0, explicit.stderr);
  const payload = JSON.parse(explicit.stdout);
  const key = readIndexNowKey();
  assert.deepEqual(payload, {
    host: "dealeraivisibility.com",
    key,
    keyLocation: `https://dealeraivisibility.com/${key}.txt`,
    urlList: ["https://dealeraivisibility.com/methodology/", "https://dealeraivisibility.com/contact/"],
  });
  const fromSitemap = runPing(["--dry-run", "--from-sitemap"]);
  assert.equal(fromSitemap.status, 0, fromSitemap.stderr);
  const sitemapPayload = JSON.parse(fromSitemap.stdout);
  assert.equal(sitemapPayload.key, key);
  assert.ok(sitemapPayload.urlList.includes("https://dealeraivisibility.com/"));
  assert.equal(sitemapPayload.urlList.every((url) => url.startsWith("https://dealeraivisibility.com/")), true);
});

test("a bad deployed ref is logged and still exits 0", () => {
  const result = runPing(["--dry-run", "--since", "not-a-ref-685f"]);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /indexnow:/);
});

test("the visibility worker serves the key as text/plain and refuses HTML fallback", async () => {
  const key = readIndexNowKey();
  const worker = (await import("../deployment/cloudflare/dealer-ai-visibility-worker.mjs")).default;
  const env = {
    ASSETS: {
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === `/${key}.txt`) return new Response(`${key}\n`, { status: 200, headers: { "content-type": "application/octet-stream" } });
        if (pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
        return new Response("<!doctype html><title>fallback</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      },
    },
  };
  const ok = await worker.fetch(new Request(`https://dealeraivisibility.com/${key}.txt`), env, {});
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") || "", /^text\/plain\b/);
  assert.equal(await ok.text(), key);

  const missing = await worker.fetch(new Request("https://dealeraivisibility.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt"), env, {});
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type") || "", /^text\/plain\b/);
  assert.equal((await missing.text()).includes("<html"), false);

  const robots = await worker.fetch(new Request("https://dealeraivisibility.com/robots.txt"), env, {});
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /User-agent/);
});
