import { classifyEngineFailure, dealerNameMentioned, normalizeDomain } from "./dealer-ai-visibility-audit.mjs";

export const ANSWER_AUDIT_VERSION = "2026-09-06.2";

export const PROVIDERS = {
  openai: { label: "ChatGPT", defaultModel: "gpt-5" },
  gemini: { label: "Gemini", defaultModel: "gemini-2.5-flash" },
  perplexity: { label: "Perplexity", defaultModel: "sonar" },
  anthropic: { label: "Claude", defaultModel: "claude-sonnet-4-20250514" },
};

export const ANSWER_AUDIT_LEVELS = [
  { level: 1, dimension: "regionalReach", label: "Regional Reach", points: 5, question: "I live about 45 minutes from {city}, {state}. Is it worth the drive to buy a new {brand} there, or should I look closer to home?" },
  { level: 2, dimension: "knowledgeDepth", label: "AI Knowledge Depth", points: 5, question: "Tell me everything you know about the {brand} dealership in {city}, {state}. What's their reputation, how big is their inventory, and what do customers say about them?" },
  { level: 3, dimension: "nonBrandDiscovery", label: "Non-Brand Discovery", points: 7, question: "I'm looking for the best SUV deals in the {city}, {state} area. I'm open to any brand. Where should I shop?" },
  { level: 4, dimension: "competitivePositioning", label: "Competitive Positioning", points: 4, question: "Compare the top {brand} dealers within 60 miles of {city}, {state}. Which one would you recommend and why?" },
  { level: 5, dimension: "serviceReputation", label: "Service Reputation", points: 4, question: "I need a trustworthy dealership near {city}, {state} for service and repairs on my {brand}. Who has the best service department in the area?" },
];

export const ANSWER_AUDIT_QUESTIONS = ANSWER_AUDIT_LEVELS.flatMap((level) => Object.keys(PROVIDERS).map((provider) => ({
  ...level,
  id: `L${String(level.level).padStart(2, "0")}-${provider}`,
  provider,
})));

const VEHICLE_BRANDS = ["Acura", "Alfa Romeo", "Audi", "BMW", "Buick", "Cadillac", "Chevrolet", "Chrysler", "Dodge", "Fiat", "Ford", "Genesis", "GMC", "Honda", "Hyundai", "Infiniti", "Jaguar", "Jeep", "Kia", "Land Rover", "Lexus", "Lincoln", "Mazda", "Mercedes-Benz", "Mini", "Mitsubishi", "Nissan", "Polestar", "Porsche", "Ram", "Rivian", "Subaru", "Tesla", "Toyota", "Volkswagen", "Volvo"];

const VIN_PATTERN = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;
const STOCK_PATTERN = /\bstock(?:\s*(?:number|no\.?|#|:|-))?\s*([A-Z0-9][A-Z0-9-]{2,19})\b/i;
const MAX_ANSWER_CHARS = 4_000;
const MAX_CITATIONS = 8;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function publicHttpUrl(value, expectedDomain = "") {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (expectedDomain && normalizeDomain(url.hostname) !== normalizeDomain(expectedDomain)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function boundedText(value, limit = MAX_ANSWER_CHARS) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function citation(value) {
  if (typeof value === "string") {
    const url = publicHttpUrl(value);
    return url ? { url, title: "Source" } : null;
  }
  const url = publicHttpUrl(value?.url || value?.uri || value?.source?.url);
  if (!url) return null;
  return { url, title: boundedText(value?.title || value?.source?.title || new URL(url).hostname, 180) };
}

function dedupeCitations(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const item = citation(value);
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    output.push(item);
    if (output.length >= MAX_CITATIONS) break;
  }
  return output;
}

function collectCitations(value, output = []) {
  if (!value || output.length >= 40) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectCitations(item, output);
    return output;
  }
  if (typeof value !== "object") return output;
  if (value.url || value.uri || value.source?.url) output.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (["usage", "input", "text", "content"].includes(key) && typeof child === "string") continue;
    collectCitations(child, output);
  }
  return output;
}

export function extractVehicleContext(value, domain = "") {
  const text = String(value?.markdown || value?.html || value?.text || value || "");
  const vins = unique([...text.matchAll(VIN_PATTERN)].map((match) => match[0].toUpperCase()));
  const stock = text.match(STOCK_PATTERN)?.[1]?.toUpperCase() || null;
  const sourceUrl = publicHttpUrl(value?.url || value?.metadata?.url || value?.metadata?.sourceURL, domain);
  return { vin: vins[0] || null, stock, sourceUrl };
}

function mergeVehicleContext(contexts) {
  return contexts.find((item) => item?.vin || item?.stock) || { vin: null, stock: null, sourceUrl: null };
}

async function fetchJson(url, init, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function firecrawlVehicleContext(input, env, fetchImpl) {
  if (!env.FIRECRAWL_API_KEY) return null;
  const domain = normalizeDomain(input.homepageUrl);
  const base = String(env.FIRECRAWL_API_URL || "https://api.firecrawl.dev/v2").replace(/\/$/, "");
  const { response, body } = await fetchJson(`${base}/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `site:${domain} (new OR used) vehicle (VIN OR stock)`,
      sources: [{ type: "web" }],
      limit: 5,
      country: "US",
      ignoreInvalidURLs: true,
      timeout: 25_000,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: false, waitFor: 1_000, maxAge: 3_600_000, removeBase64Images: true },
    }),
  }, fetchImpl, 30_000);
  if (!response.ok) throw Object.assign(new Error("firecrawl_search_failed"), { status: response.status, body });
  const rows = Array.isArray(body?.data?.web) ? body.data.web : [];
  const contexts = rows.map((row) => extractVehicleContext({ ...row, url: row.url }, domain));
  return mergeVehicleContext(contexts);
}

async function nativeVehicleContext(input, fetchImpl) {
  const domain = normalizeDomain(input.homepageUrl);
  const candidates = [input.homepageUrl, `https://${domain}/sitemap.xml`, `https://www.${domain}/sitemap.xml`];
  const contexts = [];
  for (const url of unique(candidates)) {
    try {
      const response = await fetchImpl(url, { headers: { Accept: "text/html,application/xml", "User-Agent": "DealerAIVisibility/1.0" }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) continue;
      const text = (await response.text()).slice(0, 2_000_000);
      contexts.push(extractVehicleContext({ text, url: response.url || url }, domain));
      const listingUrls = [...text.matchAll(/https?:\/\/[^\s<"']+/gi)].map((match) => match[0].replace(/&amp;/g, "&")).filter((item) => /\/(?:new|used|inventory)\b/i.test(item)).slice(0, 3);
      for (const listingUrl of listingUrls) {
        const safeUrl = publicHttpUrl(listingUrl, domain);
        if (!safeUrl) continue;
        const listing = await fetchImpl(safeUrl, { headers: { Accept: "text/html", "User-Agent": "DealerAIVisibility/1.0" }, signal: AbortSignal.timeout(8_000) });
        if (listing.ok) contexts.push(extractVehicleContext({ text: (await listing.text()).slice(0, 2_000_000), url: listing.url || safeUrl }, domain));
        if (contexts.some((item) => item.vin && item.stock)) break;
      }
    } catch { /* discovery is best effort */ }
    if (contexts.some((item) => item.vin && item.stock)) break;
  }
  return mergeVehicleContext(contexts);
}

export async function discoverVehicleContext(input, env, fetchImpl = fetch) {
  try {
    const firecrawl = await firecrawlVehicleContext(input, env, fetchImpl);
    if (firecrawl?.vin || firecrawl?.stock) return { ...firecrawl, method: "firecrawl" };
  } catch (error) {
    console.warn(JSON.stringify({ event: "answer_audit_vehicle_discovery_failed", provider: "firecrawl", error: error?.message || String(error) }));
  }
  const native = await nativeVehicleContext(input, fetchImpl);
  return { ...native, method: native.vin || native.stock ? "public_site" : "not_verifiable" };
}

export function deriveBrand(input) {
  const supplied = boundedText(input.brand, 80);
  if (supplied) return supplied;
  const name = boundedText(input.dealershipName, 160);
  const matches = VEHICLE_BRANDS.filter((brand) => new RegExp(`\\b${brand.replace("-", "[- ]")}\\b`, "i").test(name));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return `${matches.slice(0, -1).join(", ")} or ${matches.at(-1)}`;
  return "vehicle";
}

export function parseMarket(value) {
  const parts = boundedText(value, 120).split(",").map((item) => item.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts.slice(0, -1).join(", "), state: parts.at(-1) };
  return { city: parts[0] || "the local area", state: "" };
}

export function materializeQuestion(question, input) {
  const domain = normalizeDomain(input.homepageUrl);
  const market = parseMarket(input.city);
  const prompt = question.question
    .replaceAll("{brand}", deriveBrand(input))
    .replaceAll("{city}", market.city)
    .replaceAll(", {state}", market.state ? `, ${market.state}` : "")
    .replaceAll("{state}", market.state);
  return `${prompt}\n\nDealership being measured: ${boundedText(input.dealershipName, 160)}. Dealer website: https://${domain}/. Use current public web evidence and cite the sources used. Do not favor the measured dealership unless the evidence supports it.`;
}

export function parseOpenAI(body) {
  const text = body?.output_text || (body?.output || []).flatMap((item) => item?.content || []).filter((item) => item?.type === "output_text" || item?.type === "text").map((item) => item?.text || "").join(" ");
  return { answer: boundedText(text), citations: dedupeCitations(collectCitations(body?.output || [])) };
}

export function parseGemini(body) {
  const candidate = body?.candidates?.[0] || {};
  const text = (candidate?.content?.parts || []).map((part) => part?.text || "").join(" ");
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  return { answer: boundedText(text), citations: dedupeCitations(chunks.map((item) => item?.web || item)) };
}

export function parsePerplexity(body) {
  const answer = body?.choices?.[0]?.message?.content || "";
  return { answer: boundedText(answer), citations: dedupeCitations([...(body?.search_results || []), ...(body?.citations || [])]) };
}

export function parseAnthropic(body) {
  const blocks = body?.content || [];
  const answer = blocks.filter((item) => item?.type === "text").map((item) => item?.text || "").join(" ");
  return { answer: boundedText(answer), citations: dedupeCitations(collectCitations(blocks)) };
}

function providerRequest(provider, prompt, input, env) {
  const sharedSystem = `You are recording a dealership visibility observation. Answer only from current public web evidence. Do not infer inventory availability, price eligibility, fees, or discount stacking. If evidence is insufficient, say Not verifiable. Focus on ${input.dealershipName} and cite the sources used.`;
  if (provider === "openai") return {
    key: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || PROVIDERS.openai.defaultModel,
    url: "https://api.openai.com/v1/responses",
    init: { method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: env.OPENAI_MODEL || PROVIDERS.openai.defaultModel, tools: [{ type: "web_search" }], input: `${sharedSystem}\n\n${prompt}`, max_output_tokens: 700 }) },
    parse: parseOpenAI,
  };
  if (provider === "gemini") {
    const model = env.GEMINI_MODEL || PROVIDERS.gemini.defaultModel;
    return {
      key: env.GEMINI_API_KEY,
      model,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      init: { method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: sharedSystem }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 700, temperature: 0.1 } }) },
      parse: parseGemini,
    };
  }
  if (provider === "perplexity") return {
    key: env.PERPLEXITY_API_KEY,
    model: env.PERPLEXITY_MODEL || PROVIDERS.perplexity.defaultModel,
    url: "https://api.perplexity.ai/v1/sonar",
    init: { method: "POST", headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: env.PERPLEXITY_MODEL || PROVIDERS.perplexity.defaultModel, messages: [{ role: "system", content: sharedSystem }, { role: "user", content: prompt }], search_context_size: "low", max_tokens: 700, temperature: 0.1 }) },
    parse: parsePerplexity,
  };
  if (provider === "anthropic") return {
    key: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL || PROVIDERS.anthropic.defaultModel,
    url: "https://api.anthropic.com/v1/messages",
    init: { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, body: JSON.stringify({ model: env.ANTHROPIC_MODEL || PROVIDERS.anthropic.defaultModel, max_tokens: 700, system: sharedSystem, messages: [{ role: "user", content: prompt }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] }) },
    parse: parseAnthropic,
  };
  return null;
}

export function assessAnswer(answer, citations, input) {
  const domain = normalizeDomain(input.homepageUrl);
  const lower = String(answer || "").toLowerCase();
  const dealerSource = citations.some((item) => normalizeDomain(item.url) === domain);
  const availabilityClaim = /\b(?:available now|currently available|in stock|on the lot)\b/i.test(answer);
  const uncertainty = /\b(?:not verifiable|could not verify|cannot verify|contact the dealer|confirm with the dealer|availability may change)\b/i.test(answer);
  return {
    dealerMentioned: dealerNameMentioned(answer, input.dealershipName),
    citationCount: citations.length,
    dealerSource,
    uncertainty,
    unsupportedAvailability: availabilityClaim && !dealerSource && !uncertainty,
    answerPresent: Boolean(lower),
  };
}

export async function runQuestion(question, input, _vehicle, env, fetchImpl = fetch) {
  const prompt = materializeQuestion(question, input);
  const request = providerRequest(question.provider, prompt, input, env);
  const observedAt = new Date().toISOString();
  if (!request?.key) return { questionId: question.id, dimension: question.dimension, provider: question.provider, providerLabel: PROVIDERS[question.provider]?.label || question.provider, model: request?.model || PROVIDERS[question.provider]?.defaultModel || "unknown", prompt, status: "unavailable", answer: "", citations: [], observedAt, latencyMs: 0, errorCode: "not_configured", assessment: null };
  const started = Date.now();
  try {
    const { response, body } = await fetchJson(request.url, request.init, fetchImpl, 30_000);
    if (!response.ok) {
      const errorCode = classifyEngineFailure(response.status, JSON.stringify(body));
      return { questionId: question.id, dimension: question.dimension, provider: question.provider, providerLabel: PROVIDERS[question.provider].label, model: request.model, prompt, status: "unavailable", answer: "", citations: [], observedAt, latencyMs: Date.now() - started, errorCode, assessment: null };
    }
    const parsed = request.parse(body);
    if (!parsed.answer) return { questionId: question.id, dimension: question.dimension, provider: question.provider, providerLabel: PROVIDERS[question.provider].label, model: request.model, prompt, status: "unavailable", answer: "", citations: parsed.citations, observedAt, latencyMs: Date.now() - started, errorCode: "empty_response", assessment: null };
    const assessment = assessAnswer(parsed.answer, parsed.citations, input);
    return { questionId: question.id, dimension: question.dimension, provider: question.provider, providerLabel: PROVIDERS[question.provider].label, model: request.model, prompt, status: assessment.dealerMentioned ? "mentioned" : "not_mentioned", answer: parsed.answer, citations: parsed.citations, observedAt, latencyMs: Date.now() - started, errorCode: null, assessment };
  } catch (error) {
    return { questionId: question.id, dimension: question.dimension, provider: question.provider, providerLabel: PROVIDERS[question.provider].label, model: request.model, prompt, status: "unavailable", answer: "", citations: [], observedAt, latencyMs: Date.now() - started, errorCode: classifyEngineFailure(0, "", error), assessment: null };
  }
}

export function summarizeAnswerAudit(results) {
  const completed = results.filter((item) => item.status !== "unavailable");
  const providers = Object.keys(PROVIDERS).map((provider) => {
    const rows = results.filter((item) => item.provider === provider);
    const successes = rows.filter((item) => item.status !== "unavailable").length;
    const errors = unique(rows.filter((item) => item.errorCode).map((item) => item.errorCode));
    return { provider, label: PROVIDERS[provider].label, status: successes === rows.length ? "ok" : successes ? "degraded" : rows.every((item) => item.errorCode === "not_configured") ? "not_configured" : "unavailable", successes, total: rows.length, errorCodes: errors };
  });
  const dimensions = unique(results.map((item) => item.dimension)).map((dimension) => {
    const rows = results.filter((item) => item.dimension === dimension);
    return { dimension, observed: rows.filter((item) => item.status !== "unavailable").length, total: rows.length, mentioned: rows.filter((item) => item.status === "mentioned").length };
  });
  const levels = ANSWER_AUDIT_LEVELS.map((definition) => {
    const rows = results.filter((item) => item.dimension === definition.dimension);
    const observed = rows.filter((item) => item.status !== "unavailable");
    const mentions = rows.filter((item) => item.status === "mentioned").length;
    const passed = mentions > 0;
    return { level: definition.level, dimension: definition.dimension, label: definition.label, points: definition.points, pointsEarned: passed ? definition.points : 0, passed, observed: observed.length, total: rows.length, mentions };
  });
  const ranked = levels.filter((item) => item.observed).sort((a, b) => (b.mentions / b.observed) - (a.mentions / a.observed));
  return {
    total: results.length,
    observed: completed.length,
    unavailable: results.length - completed.length,
    mentioned: results.filter((item) => item.status === "mentioned").length,
    cited: completed.filter((item) => item.assessment?.citationCount > 0).length,
    dealerSourced: completed.filter((item) => item.assessment?.dealerSource).length,
    unsupportedAvailabilityFlags: completed.filter((item) => item.assessment?.unsupportedAvailability).length,
    aiScore: levels.reduce((total, item) => total + item.pointsEarned, 0),
    maxAiScore: 25,
    levelsPassedCount: levels.filter((item) => item.passed).length,
    strongestLevel: ranked[0]?.label || null,
    weakestLevel: ranked.at(-1)?.label || null,
    providers,
    levels,
    dimensions,
  };
}

export async function runAnswerAudit(input, env, fetchImpl = fetch, questions = ANSWER_AUDIT_QUESTIONS) {
  const startedAt = new Date().toISOString();
  const settled = await Promise.allSettled(questions.map((question) => runQuestion(question, input, null, env, fetchImpl)));
  const results = settled.map((item, index) => item.status === "fulfilled" ? item.value : {
    questionId: questions[index].id,
    dimension: questions[index].dimension,
    provider: questions[index].provider,
    providerLabel: PROVIDERS[questions[index].provider].label,
    model: PROVIDERS[questions[index].provider].defaultModel,
    prompt: materializeQuestion(questions[index], input),
    status: "unavailable",
    answer: "",
    citations: [],
    observedAt: new Date().toISOString(),
    latencyMs: 0,
    errorCode: "network_error",
    assessment: null,
  });
  const summary = summarizeAnswerAudit(results);
  return {
    version: ANSWER_AUDIT_VERSION,
    status: summary.observed === results.length ? "complete" : summary.observed ? "partial" : "unavailable",
    startedAt,
    completedAt: new Date().toISOString(),
    queryContext: { brand: deriveBrand(input), ...parseMarket(input.city) },
    summary,
    results,
    notice: "Automated public-web observations are evidence for review, not a guarantee of factual accuracy or current availability.",
  };
}
