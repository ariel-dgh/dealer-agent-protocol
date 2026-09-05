import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeRobots,
  auditWebsiteReadiness,
  classifyEngineFailure,
  cleanAiResponse,
  dealerNameMentioned,
  gradeScore,
  isValidPublicUrl,
  normalizeDomain,
  probeLlmsTxt,
  rescaleTechnicalScore,
  scoreDiscoverability,
  scoreSchemaMarkup,
  settleWithDeadline,
} from "../deployment/cloudflare/dealer-ai-visibility-audit.mjs";

test("cleanAiResponse strips markdown and URLs and caps output", () => {
  const value = cleanAiResponse(`## [Dealer](https://example.com) **wins** ${"x".repeat(500)}`);
  assert.equal(value.includes("http"), false);
  assert.equal(value.includes("**"), false);
  assert.equal(value.length, 400);
});

test("grade boundaries and 75-point rescaling are stable", () => {
  assert.deepEqual([80, 65, 50, 35, 20, 19].map(gradeScore), ["A", "B", "C", "D", "E", "F"]);
  assert.deepEqual([0, 37, 75].map(rescaleTechnicalScore), [0, 49, 100]);
});

test("schema pillar recognizes every specified type and caps at 25", () => {
  const html = `<script type="application/ld+json">{"@graph":[{"@type":"AutoDealer"},{"@type":"FAQPage"},{"@type":"AggregateRating"},{"@type":"Vehicle"}]}</script>`;
  assert.equal(scoreSchemaMarkup(html).score, 25);
});

test("discoverability only awards observed signals", () => {
  const html = `<html lang="en"><head><meta name="description" content="${"Useful dealer description ".repeat(3)}"><link rel="canonical" href="https://dealer.example/"></head><body><h1>Dealer</h1><h2>A</h2><h2>B</h2><a href="/1">1</a><a href="/2">2</a><a href="/3">3</a><a href="/4">4</a><a href="/5">5</a></body></html>`;
  const result = scoreDiscoverability(html, "https://dealer.example/", new Date("2026-09-05T00:00:00Z"));
  assert.equal(result.checks.find((item) => item.id === "meta-description").status, "pass");
  assert.equal(result.checks.find((item) => item.id === "open-graph").status, "fail");
  assert.equal(result.checks.find((item) => item.id === "internal-links").status, "pass");
});

test("an empty or unreachable page earns no image-alt points", () => {
  const result = scoreDiscoverability("", "https://dealer.example/", new Date("2026-09-05T00:00:00Z"));
  assert.equal(result.score, 0);
  assert.equal(result.checks.find((item) => item.id === "image-alt").status, "fail");
});

test("robots analyzer preserves all policy states", () => {
  assert.equal(analyzeRobots("", false).status, "missing");
  assert.equal(analyzeRobots("User-agent: *\nAllow: /").status, "not_configured");
  assert.equal(analyzeRobots("User-agent: GPTBot\nAllow: /").status, "open");
  assert.equal(analyzeRobots("User-agent: GPTBot\nDisallow: /wp-admin/").status, "infra_only");
  assert.equal(analyzeRobots("User-agent: GPTBot\nDisallow: /inventory/").status, "partial");
  assert.equal(analyzeRobots("User-agent: GPTBot\nDisallow: /").status, "blocked");
  assert.deepEqual([
    analyzeRobots("User-agent: GPTBot\nAllow: /").policyScore,
    analyzeRobots("User-agent: GPTBot\nDisallow: /wp-admin/").policyScore,
    analyzeRobots("User-agent: GPTBot\nDisallow: /inventory/").policyScore,
    analyzeRobots("User-agent: GPTBot\nDisallow: /").policyScore,
    analyzeRobots("User-agent: *\nAllow: /").policyScore,
  ], [10, 10, 5, 0, 5]);
});

test("SSRF guard rejects private, metadata, local, numeric, and non-http targets", () => {
  const blocked = ["http://127.0.0.1", "http://10.0.0.5", "http://localhost", "https://foo.local", "http://169.254.169.254", "https://metadata.google.internal", "file:///etc/passwd", "http://2130706433"];
  for (const value of blocked) assert.equal(isValidPublicUrl(value), false, value);
  assert.equal(isValidPublicUrl("https://dealer.example/inventory"), true);
});

test("domain normalizer strips scheme, www, path, and trailing dot", () => {
  assert.equal(normalizeDomain("https://www.Dealer.Example/inventory/"), "dealer.example");
  assert.equal(normalizeDomain("dealer.example/"), "dealer.example");
  assert.equal(normalizeDomain("not a domain"), "");
});

test("llms.txt probe supports direct, www fallback, robots pointer, and minimal files", async () => {
  const response = (url, body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
  const wwwFetch = async (url) => url.includes("www.") ? response(url, "# Dealer\n" + "Useful guidance ".repeat(5)) : response(url, "", 404);
  assert.equal((await probeLlmsTxt("https://dealer.example", "", wwwFetch)).score, 10);
  const pointerFetch = async (url) => url.includes("instructions.example") ? response(url, "# Dealer\n" + "Inventory and service facts ".repeat(4)) : response(url, "", 404);
  assert.equal((await probeLlmsTxt("https://dealer.example", "llms.txt: https://instructions.example/ai.txt", pointerFetch)).score, 10);
  const minimalFetch = async (url) => response(url, "# Dealer");
  assert.equal((await probeLlmsTxt("https://dealer.example", "", minimalFetch)).score, 5);
});

test("engine failures are classified without turning outages into negative mentions", () => {
  assert.equal(classifyEngineFailure(429, "insufficient_quota"), "quota_exceeded");
  assert.equal(classifyEngineFailure(401, "unauthorized"), "auth_error");
  assert.equal(classifyEngineFailure(0, "", { name: "AbortError" }), "timeout");
  assert.equal(classifyEngineFailure(503, "unavailable"), "provider_down");
});

test("visibility mention passes only on the normalized real dealer name", () => {
  assert.equal(dealerNameMentioned("Try Acme Buick GMC LLC in the city.", "Acme Buick GMC"), true);
  assert.equal(dealerNameMentioned("Try the local Buick store.", "Acme Buick GMC"), false);
});

test("global deadline returns completed work and nulls for pending work", async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 50));
  const results = await settleWithDeadline([Promise.resolve("ready"), slow], 5);
  assert.deepEqual(results[0], { status: "fulfilled", value: "ready" });
  assert.equal(results[1], null);
});

test("full readiness audit returns the three 25-point pillars", async () => {
  const fetchMock = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: GPTBot\nAllow: /", { status: 200 });
    if (url.endsWith("/llms.txt")) return new Response("# Dealer\n" + "Verified inventory facts. ".repeat(5), { status: 200 });
    if (url.endsWith("/sitemap.xml")) return new Response("<urlset></urlset>", { status: 200 });
    if (url.includes(".well-known")) return new Response("", { status: 404 });
    return new Response(`<html lang="en"><head><meta name="description" content="${"Dealer facts ".repeat(8)}"><meta property="og:title" content="Dealer"><meta property="og:description" content="Dealer facts"><meta property="og:image" content="image.jpg"><link rel="canonical" href="https://dealer.example/"><script type="application/ld+json">{"@type":"AutoDealer"}</script></head><body><h1>Dealer</h1><h2>Inventory</h2><h2>Service</h2><p>Frequently asked questions 2026</p><a href="/1">1</a><a href="/2">2</a><a href="/3">3</a><a href="/4">4</a><a href="/5">5</a></body></html>`, { status: 200 });
  };
  const result = await auditWebsiteReadiness("https://dealer.example/", fetchMock, new Date("2026-09-05T00:00:00Z"));
  assert.deepEqual(Object.keys(result.pillars), ["schema", "discoverability", "fileReadiness"]);
  assert.equal(result.maxRawScore, 75);
  assert.equal(result.pillars.fileReadiness.score, 25);
});

test("public report is enriched with evidence and never exposes stored contact data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("supabase.co")) return new Response(JSON.stringify({ id: "report-1", short_id: "abc123", homepage_url: "https://dealer.example/", dealership_name: "Example Motors", email: "private@example.com", phone: "555-0100", category_scores: {}, platform_scores: {}, findings: [] }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/robots.txt")) return new Response("User-agent: GPTBot\nAllow: /", { status: 200 });
    if (url.endsWith("/llms.txt")) return new Response("# Dealer\n" + "Public dealership facts. ".repeat(5), { status: 200 });
    if (url.endsWith("/sitemap.xml")) return new Response("<urlset></urlset>", { status: 200 });
    if (url.includes(".well-known")) return new Response("", { status: 404 });
    return new Response("<html lang=\"en\"><h1>Example Motors</h1></html>", { status: 200 });
  };
  try {
    const worker = (await import("../deployment/cloudflare/dealer-ai-visibility-worker.mjs")).default;
    const response = await worker.fetch(new Request("https://dealeraivisibility.com/api/report/abc123"), { SUPABASE_ANON_KEY: "public-anon-key" }, {});
    const report = await response.json();
    assert.equal(response.status, 200);
    assert.equal(report.website_readiness.maxRawScore, 75);
    assert.equal("email" in report, false);
    assert.equal("phone" in report, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
