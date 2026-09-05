const AI_CRAWLERS = [
  "gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-searchbot",
  "claude-user", "perplexitybot", "perplexity-user", "google-extended", "amazonbot",
  "bytespider", "ccbot",
];

const INFRASTRUCTURE_PATHS = [
  "/wp-admin", "/wp-login", "/cgi-bin", "/api", "/assets", "/static", "/admin",
];

const PRIVATE_IPV4 = /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

export function normalizeDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    return new URL(candidate).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function isValidPublicUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host.includes(".") || host === "localhost" || host.endsWith(".local")) return false;
    if (host.includes("metadata") || host.includes("internal")) return false;
    if (PRIVATE_IPV4.test(host) || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
    if (/^\d+$/.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export function gradeScore(score) {
  const value = Number(score) || 0;
  if (value >= 80) return "A";
  if (value >= 65) return "B";
  if (value >= 50) return "C";
  if (value >= 35) return "D";
  if (value >= 20) return "E";
  return "F";
}

export function rescaleTechnicalScore(raw) {
  return Math.max(0, Math.min(100, Math.round((Number(raw) || 0) / 75 * 100)));
}

function check(id, label, passed, points, evidence) {
  return { id, label, status: passed ? "pass" : "fail", points: passed ? points : 0, maxPoints: points, evidence };
}

function countMatches(value, expression) {
  return [...String(value || "").matchAll(expression)].length;
}

export function scoreSchemaMarkup(html) {
  const source = String(html || "");
  const hasAny = /application\/ld\+json|itemtype\s*=\s*["'][^"']*schema\.org/i.test(source);
  const hasDealer = /["']@type["']\s*:\s*(?:["'](?:AutoDealer|LocalBusiness)["']|\[[^\]]*(?:AutoDealer|LocalBusiness))/i.test(source)
    || /schema\.org\/(?:AutoDealer|LocalBusiness)/i.test(source);
  const hasFaq = /["']@type["']\s*:\s*["']FAQPage["']/i.test(source) || /schema\.org\/FAQPage/i.test(source);
  const hasReview = /["']@type["']\s*:\s*(?:["'](?:Review|AggregateRating)["']|\[[^\]]*(?:Review|AggregateRating))/i.test(source)
    || /schema\.org\/(?:Review|AggregateRating)/i.test(source);
  const hasVehicle = /["']@type["']\s*:\s*(?:["'](?:Product|Vehicle|Car)["']|\[[^\]]*(?:Product|Vehicle|Car))/i.test(source)
    || /schema\.org\/(?:Product|Vehicle|Car)/i.test(source);
  const checks = [
    check("dealer-schema", "AutoDealer or LocalBusiness schema", hasDealer, 8, hasDealer ? "Dealer identity schema found." : "No AutoDealer or LocalBusiness type found."),
    check("faq-schema", "FAQPage schema", hasFaq, 5, hasFaq ? "FAQPage schema found." : "No FAQPage type found."),
    check("review-schema", "Review or AggregateRating schema", hasReview, 5, hasReview ? "Review evidence schema found." : "No Review or AggregateRating type found."),
    check("vehicle-schema", "Product or Vehicle schema", hasVehicle, 4, hasVehicle ? "Inventory schema found in the observed page." : "No Product or Vehicle type found on the observed page."),
    check("any-schema", "Machine-readable schema present", hasAny, 3, hasAny ? "JSON-LD or schema.org microdata found." : "No JSON-LD or schema.org microdata found."),
  ];
  return { score: Math.min(25, checks.reduce((sum, item) => sum + item.points, 0)), maxScore: 25, checks };
}

function tagContent(html, name, attribute = "name") {
  const source = String(html || "");
  const patterns = [
    new RegExp(`<meta[^>]+${attribute}\\s*=\\s*["']${name}["'][^>]+content\\s*=\\s*["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]+${attribute}\\s*=\\s*["']${name}["']`, "i"),
  ];
  return patterns.map((pattern) => source.match(pattern)?.[1] || "").find(Boolean) || "";
}

export function scoreDiscoverability(html, baseUrl, now = new Date()) {
  const source = String(html || "");
  const description = tagContent(source, "description");
  const ogComplete = ["og:title", "og:description", "og:image"].every((name) => tagContent(source, name, "property"));
  const canonical = /<link[^>]+rel\s*=\s*["'][^"']*canonical[^"']*["'][^>]+href\s*=|<link[^>]+href\s*=\s*["'][^"']+["'][^>]+rel\s*=\s*["'][^"']*canonical/i.test(source);
  const h1Count = countMatches(source, /<h1\b[^>]*>/gi);
  const h2Count = countMatches(source, /<h2\b[^>]*>/gi);
  const faq = /FAQPage|<details\b|\b(?:Q:|Question:)\s*[^<]{4,}|frequently asked questions/i.test(source);
  const currentYear = now.getUTCFullYear();
  const fresh = new RegExp(`\\b(?:${currentYear}|${currentYear - 1})\\b`).test(source);
  const lang = /<html[^>]+lang\s*=\s*["'][a-z]{2}(?:-[a-z]{2})?["']/i.test(source);
  const images = [...source.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const imagesWithAlt = images.filter((tag) => /\balt\s*=\s*["'][^"']+["']/i.test(tag)).length;
  const altCoverage = images.length > 0 && imagesWithAlt / images.length >= .8;
  let internalLinks = 0;
  const baseHost = normalizeDomain(baseUrl);
  for (const match of source.matchAll(/<a\b[^>]+href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const link = new URL(match[1], baseUrl);
      if (["http:", "https:"].includes(link.protocol) && normalizeDomain(link.href) === baseHost) internalLinks += 1;
    } catch { /* malformed link */ }
  }
  const checks = [
    check("meta-description", "Meta description is at least 50 characters", description.trim().length >= 50, 3, description ? `${description.trim().length} characters observed.` : "No meta description observed."),
    check("open-graph", "Open Graph title, description, and image", ogComplete, 3, ogComplete ? "All three core Open Graph tags found." : "One or more core Open Graph tags are missing."),
    check("canonical", "Canonical URL", canonical, 2, canonical ? "Canonical link found." : "No canonical link found."),
    check("h1", "Clear H1 heading", h1Count >= 1, 3, `${h1Count} H1 heading${h1Count === 1 ? "" : "s"} observed.`),
    check("h2", "At least two supporting H2 headings", h2Count >= 2, 3, `${h2Count} H2 headings observed.`),
    check("faq-content", "Direct FAQ-style answers", faq, 3, faq ? "FAQ-style content found." : "No FAQ-style content found on the observed page."),
    check("freshness", "Current or recent-year signal", fresh, 2, fresh ? `A ${currentYear} or ${currentYear - 1} freshness signal was found.` : "No current or recent-year signal found."),
    check("html-language", "Page language declared", lang, 2, lang ? "The html element declares a language." : "No html language declaration found."),
    check("image-alt", "At least 80% image-alt coverage", altCoverage, 2, images.length ? `${imagesWithAlt} of ${images.length} images have descriptive alt text.` : "No images were present on the observed page."),
    check("internal-links", "At least five internal links", internalLinks >= 5, 2, `${internalLinks} internal links observed.`),
  ];
  return { score: Math.min(25, checks.reduce((sum, item) => sum + item.points, 0)), maxScore: 25, checks };
}

function parseRobotsGroups(content) {
  const groups = [];
  let current = null;
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && ["allow", "disallow"].includes(field)) {
      current.rules.push({ field, value });
    }
  }
  return groups;
}

export function analyzeRobots(content, exists = true) {
  if (!exists) return { status: "missing", label: "Missing", score: 0, existenceScore: 0, policyScore: 0, maxScore: 15, exists: false, blocksAI: false, evidence: "robots.txt was not reachable." };
  const groups = parseRobotsGroups(content);
  const aiGroups = groups.filter((group) => group.agents.some((agent) => AI_CRAWLERS.includes(agent)));
  if (!aiGroups.length) return { status: "not_configured", label: "AI crawlers not named", score: 10, existenceScore: 5, policyScore: 5, maxScore: 15, exists: true, blocksAI: false, evidence: "robots.txt exists, but no major AI crawler is addressed explicitly." };
  const disallows = aiGroups.flatMap((group) => group.rules.filter((rule) => rule.field === "disallow" && rule.value).map((rule) => rule.value));
  const blocksAll = disallows.some((path) => path === "/" || path === "/*");
  if (blocksAll) return { status: "blocked", label: "AI crawlers blocked", score: 5, existenceScore: 5, policyScore: 0, maxScore: 15, exists: true, blocksAI: true, evidence: "At least one named AI crawler is disallowed from the entire site." };
  if (!disallows.length) return { status: "open", label: "AI crawlers open", score: 15, existenceScore: 5, policyScore: 10, maxScore: 15, exists: true, blocksAI: false, evidence: "Named AI crawler groups contain no blocking rules." };
  const infrastructureOnly = disallows.every((path) => INFRASTRUCTURE_PATHS.some((prefix) => path.toLowerCase().startsWith(prefix)));
  if (infrastructureOnly) return { status: "infra_only", label: "Open except infrastructure", score: 15, existenceScore: 5, policyScore: 10, maxScore: 15, exists: true, blocksAI: false, evidence: "Only administrative or infrastructure paths are restricted." };
  return { status: "partial", label: "Partially restricted", score: 10, existenceScore: 5, policyScore: 5, maxScore: 15, exists: true, blocksAI: false, evidence: "Named AI crawlers are restricted from one or more content paths." };
}

function publicFileCandidates(homepageUrl, path) {
  const domain = normalizeDomain(homepageUrl);
  return [`https://${domain}${path}`, `https://www.${domain}${path}`];
}

async function probeFirst(candidates, fetchImpl, timeout) {
  let last = { ok: false, status: 0, url: candidates[0], text: "", error: "not_found" };
  for (const candidate of [...new Set(candidates)]) {
    const result = await safeFetchText(candidate, fetchImpl, timeout);
    if (result.ok && result.text.trim()) return result;
    last = result;
  }
  return last;
}

async function safeFetchText(input, fetchImpl = fetch, timeout = 8_000, redirects = 0) {
  if (!isValidPublicUrl(input)) return { ok: false, status: 0, url: input, text: "", error: "blocked_url" };
  try {
    const response = await fetchImpl(input, {
      headers: { Accept: "text/html,text/plain,application/xml;q=.9,*/*;q=.5", "User-Agent": "Mozilla/5.0 (compatible; DealerAIVisibility/1.0; +https://dealeraivisibility.com/methodology/)" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location") && redirects < 3) {
      const next = new URL(response.headers.get("location"), input).toString();
      return safeFetchText(next, fetchImpl, timeout, redirects + 1);
    }
    const text = response.ok ? (await response.text()).slice(0, 2_000_000) : "";
    return { ok: response.ok, status: response.status, url: response.url || input, text, error: response.ok ? null : "http_error" };
  } catch (error) {
    return { ok: false, status: 0, url: input, text: "", error: error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "network_error" };
  }
}

export async function probeLlmsTxt(homepageUrl, robotsText = "", fetchImpl = fetch) {
  const domain = normalizeDomain(homepageUrl);
  const candidates = [
    `https://${domain}/llms.txt`,
    `https://www.${domain}/llms.txt`,
  ];
  const pointer = String(robotsText || "").match(/^\s*llms\.txt\s*:\s*(https?:\/\/\S+)/im)?.[1];
  if (pointer) candidates.push(pointer);
  let unavailable = false;
  for (const candidate of [...new Set(candidates)]) {
    const result = await safeFetchText(candidate, fetchImpl, 8_000);
    const content = result.text.trim();
    if (result.ok && content) {
      return { found: true, score: content.length > 50 ? 10 : 5, maxScore: 10, url: result.url || candidate, minimal: content.length <= 50, evidence: content.length > 50 ? "A substantive llms.txt file was found." : "llms.txt exists but contains minimal guidance." };
    }
    if (result.status !== 404) unavailable = true;
  }
  return { found: false, unavailable, score: 0, maxScore: 10, url: null, minimal: false, evidence: unavailable ? "One or more llms.txt locations could not be observed reliably." : "No llms.txt file was found at the direct, www, or robots.txt-declared location." };
}

function unavailablePillar(pillar, message) {
  return { ...pillar, score: 0, checks: pillar.checks.map((item) => ({ ...item, status: "unavailable", points: 0, evidence: message })) };
}

export async function auditWebsiteReadiness(homepageUrl, fetchImpl = fetch, now = new Date()) {
  if (!isValidPublicUrl(homepageUrl)) throw new Error("unsafe_homepage_url");
  const [homepage, robots] = await Promise.all([
    safeFetchText(homepageUrl, fetchImpl, 12_000),
    probeFirst(publicFileCandidates(homepageUrl, "/robots.txt"), fetchImpl, 8_000),
  ]);
  const [llms, sitemap, aiPlugin] = await Promise.all([
    probeLlmsTxt(homepageUrl, robots.text, fetchImpl),
    probeFirst(publicFileCandidates(homepageUrl, "/sitemap.xml"), fetchImpl, 8_000),
    probeFirst(publicFileCandidates(homepageUrl, "/.well-known/ai-plugin.json"), fetchImpl, 8_000),
  ]);
  const schema = homepage.ok ? scoreSchemaMarkup(homepage.text) : unavailablePillar(scoreSchemaMarkup(""), "The homepage could not be observed reliably, so this check was not scored.");
  const discoverability = homepage.ok ? scoreDiscoverability(homepage.text, homepage.url || homepageUrl, now) : unavailablePillar(scoreDiscoverability("", homepageUrl, now), "The homepage could not be observed reliably, so this check was not scored.");
  const robotsUnavailable = !robots.ok && robots.status !== 404;
  const robotsAnalysis = robotsUnavailable
    ? { status: "unavailable", label: "Unavailable", score: 0, existenceScore: 0, policyScore: 0, maxScore: 15, exists: false, blocksAI: false, evidence: "robots.txt could not be observed reliably, so no policy conclusion was drawn." }
    : analyzeRobots(robots.text, robots.ok && Boolean(robots.text.trim()));
  const fileReadiness = {
    score: Math.min(25, robotsAnalysis.score + llms.score),
    maxScore: 25,
    checks: [
      { id: "robots", label: "robots.txt and AI crawler policy", status: robotsAnalysis.status === "unavailable" ? "unavailable" : robotsAnalysis.status === "blocked" || robotsAnalysis.status === "missing" ? "fail" : robotsAnalysis.status === "partial" || robotsAnalysis.status === "not_configured" ? "partial" : "pass", points: robotsAnalysis.score, maxPoints: 15, evidence: robotsAnalysis.evidence, url: robots.ok ? robots.url : null },
      { id: "llms", label: "llms.txt guidance", status: llms.unavailable ? "unavailable" : !llms.found ? "fail" : llms.minimal ? "partial" : "pass", points: llms.score, maxPoints: 10, evidence: llms.evidence, url: llms.url },
      { id: "sitemap", label: "XML sitemap detected", status: sitemap.ok && /<(?:urlset|sitemapindex)\b/i.test(sitemap.text) ? "pass" : sitemap.status !== 404 ? "unavailable" : "fail", points: 0, maxPoints: 0, evidence: sitemap.ok ? "A sitemap response was observed; this is reported but not scored." : sitemap.status !== 404 ? "sitemap.xml could not be observed reliably; this optional artifact is not scored." : "No sitemap.xml response was observed; this is reported but not scored.", url: sitemap.ok ? sitemap.url : null },
      { id: "ai-plugin", label: "AI plugin manifest detected", status: aiPlugin.ok ? "pass" : aiPlugin.status !== 404 ? "unavailable" : "not_applicable", points: 0, maxPoints: 0, evidence: aiPlugin.ok ? "An AI plugin manifest was observed; this is reported but not scored." : aiPlugin.status !== 404 ? "The optional AI plugin location could not be observed reliably; it is not scored." : "No AI plugin manifest was observed; this optional artifact is not scored.", url: aiPlugin.ok ? aiPlugin.url : null },
    ],
    robotsStatus: robotsAnalysis.status,
    robotsBlocksAI: robotsAnalysis.blocksAI,
  };
  const rawScore = schema.score + discoverability.score + fileReadiness.score;
  const complete = homepage.ok && !robotsUnavailable && !llms.unavailable;
  return {
    status: complete ? "complete" : "partial",
    methodologyVersion: "2026-09-05",
    observedAt: now.toISOString(),
    homepage: { requestedUrl: homepageUrl, observedUrl: homepage.url, reachable: homepage.ok, status: homepage.status, error: homepage.error },
    rawScore,
    maxRawScore: 75,
    score: complete ? rescaleTechnicalScore(rawScore) : null,
    grade: complete ? gradeScore(rescaleTechnicalScore(rawScore)) : null,
    pillars: { schema, discoverability, fileReadiness },
  };
}

export function cleanAiResponse(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[*_`>#~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function classifyEngineFailure(status, body = "", error) {
  const text = `${body} ${error?.message || ""}`.toLowerCase();
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "timeout";
  if (status === 429 || text.includes("insufficient_quota") || text.includes("quota")) return "quota_exceeded";
  if (status === 401 || status === 403 || text.includes("invalid api key") || text.includes("authentication")) return "auth_error";
  if (status >= 500) return "provider_down";
  return "network_error";
}

export function dealerNameMentioned(response, dealershipName) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/\b(?:inc|llc|ltd|the)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const haystack = normalize(response);
  const needle = normalize(dealershipName);
  return needle.length >= 4 && haystack.includes(needle);
}

export async function settleWithDeadline(tasks, timeoutMs) {
  const results = Array(tasks.length).fill(null);
  const pending = tasks.map((task, index) => Promise.resolve(task).then(
    (value) => { results[index] = { status: "fulfilled", value }; },
    (reason) => { results[index] = { status: "rejected", reason: String(reason?.message || reason) }; },
  ));
  await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  return results;
}
