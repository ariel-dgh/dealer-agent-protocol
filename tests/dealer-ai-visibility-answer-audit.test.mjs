import test from "node:test";
import assert from "node:assert/strict";
import {
  ANSWER_AUDIT_QUESTIONS,
  ANSWER_AUDIT_LEVELS,
  assessAnswer,
  deriveBrand,
  extractVehicleContext,
  materializeQuestion,
  parseAnthropic,
  parseGemini,
  parseOpenAI,
  parseMarket,
  parsePerplexity,
  runAnswerAudit,
  runQuestion,
  summarizeAnswerAudit,
} from "../deployment/cloudflare/dealer-ai-visibility-answer-audit.mjs";

const input = {
  dealershipName: "Example Buick GMC",
  city: "Example City, AL",
  homepageUrl: "https://exampledealer.com/",
};

test("answer battery is the five Dealer AEO Audit levels across four providers", () => {
  assert.equal(ANSWER_AUDIT_QUESTIONS.length, 20);
  assert.equal(ANSWER_AUDIT_LEVELS.length, 5);
  assert.equal(new Set(ANSWER_AUDIT_QUESTIONS.map((item) => item.id)).size, 20);
  assert.deepEqual(Object.fromEntries(["openai", "gemini", "perplexity", "anthropic"].map((provider) => [provider, ANSWER_AUDIT_QUESTIONS.filter((item) => item.provider === provider).length])), {
    openai: 5,
    gemini: 5,
    perplexity: 5,
    anthropic: 5,
  });
  for (const level of ANSWER_AUDIT_LEVELS) assert.equal(ANSWER_AUDIT_QUESTIONS.filter((item) => item.level === level.level).length, 4);
  assert.equal(ANSWER_AUDIT_LEVELS.reduce((total, item) => total + item.points, 0), 25);
});

test("vehicle discovery extracts a VIN, stock number, and same-domain source", () => {
  const vehicle = extractVehicleContext({
    markdown: "2026 Example Truck VIN 1GTUUDED9TZ123456 Stock # HB-2048",
    url: "https://www.exampledealer.com/new/example.htm",
  }, "exampledealer.com");
  assert.deepEqual(vehicle, { vin: "1GTUUDED9TZ123456", stock: "HB-2048", sourceUrl: "https://www.exampledealer.com/new/example.htm" });
});

test("questions preserve the original prompts and derive brand and market context", () => {
  assert.equal(deriveBrand(input), "Buick or GMC");
  assert.deepEqual(parseMarket(input.city), { city: "Example City", state: "AL" });
  const exact = materializeQuestion(ANSWER_AUDIT_QUESTIONS[0], input);
  assert.match(exact, /^I live about 45 minutes from Example City, AL\. Is it worth the drive to buy a new Buick or GMC there/);
  assert.match(exact, /Dealership being measured: Example Buick GMC/);
  assert.doesNotMatch(exact, /\{brand\}|\{city\}|\{state\}/);
});

test("provider parsers preserve answer text and normalized citations", () => {
  const openai = parseOpenAI({ output_text: "Example Buick GMC is visible.", output: [{ content: [{ type: "output_text", text: "Example", annotations: [{ type: "url_citation", url: "https://exampledealer.com/a", title: "A" }] }] }] });
  assert.equal(openai.answer, "Example Buick GMC is visible.");
  assert.equal(openai.citations[0].url, "https://exampledealer.com/a");

  const gemini = parseGemini({ candidates: [{ content: { parts: [{ text: "Gemini answer" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://exampledealer.com/b", title: "B" } }] } }] });
  assert.equal(gemini.answer, "Gemini answer");
  assert.equal(gemini.citations[0].url, "https://exampledealer.com/b");

  const perplexity = parsePerplexity({ choices: [{ message: { content: "Perplexity answer" } }], search_results: [{ url: "https://exampledealer.com/c", title: "C" }] });
  assert.equal(perplexity.answer, "Perplexity answer");
  assert.equal(perplexity.citations[0].url, "https://exampledealer.com/c");

  const anthropic = parseAnthropic({ content: [{ type: "text", text: "Claude answer", citations: [{ url: "https://exampledealer.com/d", title: "D" }] }] });
  assert.equal(anthropic.answer, "Claude answer");
  assert.equal(anthropic.citations[0].url, "https://exampledealer.com/d");
});

test("assessment distinguishes dealer citations and unsupported availability", () => {
  const supported = assessAnswer("Example Buick GMC lists it in stock.", [{ url: "https://exampledealer.com/vehicle", title: "Vehicle" }], input);
  assert.equal(supported.dealerMentioned, true);
  assert.equal(supported.dealerSource, true);
  assert.equal(supported.unsupportedAvailability, false);
  const unsupported = assessAnswer("Example Buick GMC has it available now.", [{ url: "https://thirdparty.example/item", title: "Third party" }], input);
  assert.equal(unsupported.unsupportedAvailability, true);
});

test("missing provider credentials are unavailable, not negative mentions", async () => {
  const row = await runQuestion(ANSWER_AUDIT_QUESTIONS[0], input, {}, {}, async () => { throw new Error("must not fetch"); });
  assert.equal(row.status, "unavailable");
  assert.equal(row.errorCode, "not_configured");
  assert.equal(row.answer, "");
});

test("summary keeps provider outages separate from observed misses", () => {
  const results = [
    { provider: "openai", dimension: "regionalReach", status: "mentioned", assessment: { citationCount: 1, dealerSource: true, unsupportedAvailability: false }, errorCode: null },
    { provider: "gemini", dimension: "knowledgeDepth", status: "not_mentioned", assessment: { citationCount: 1, dealerSource: false, unsupportedAvailability: false }, errorCode: null },
    { provider: "perplexity", dimension: "nonBrandDiscovery", status: "unavailable", assessment: null, errorCode: "provider_down" },
    { provider: "anthropic", dimension: "serviceReputation", status: "unavailable", assessment: null, errorCode: "not_configured" },
  ];
  const summary = summarizeAnswerAudit(results);
  assert.equal(summary.observed, 2);
  assert.equal(summary.unavailable, 2);
  assert.equal(summary.mentioned, 1);
  assert.equal(summary.aiScore, 5);
  assert.equal(summary.levelsPassedCount, 1);
  assert.equal(summary.providers.find((item) => item.provider === "perplexity").status, "unavailable");
  assert.equal(summary.providers.find((item) => item.provider === "anthropic").status, "not_configured");
});

test("complete mocked run executes every question and records evidence", async () => {
  const fetchMock = async (url) => {
    const endpoint = String(url);
    if (endpoint.includes("openai.com")) return new Response(JSON.stringify({ output_text: "Example Buick GMC: Not verifiable.", output: [{ url: "https://exampledealer.com/vehicle" }] }), { status: 200 });
    if (endpoint.includes("googleapis.com")) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Example Buick GMC: Not verifiable." }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://exampledealer.com/vehicle", title: "Vehicle" } }] } }] }), { status: 200 });
    if (endpoint.includes("perplexity.ai")) return new Response(JSON.stringify({ choices: [{ message: { content: "Example Buick GMC: Not verifiable." } }], citations: ["https://exampledealer.com/vehicle"] }), { status: 200 });
    if (endpoint.includes("anthropic.com")) return new Response(JSON.stringify({ content: [{ type: "text", text: "Example Buick GMC: Not verifiable.", citations: [{ url: "https://exampledealer.com/vehicle" }] }] }), { status: 200 });
    return new Response("", { status: 404 });
  };
  const env = { OPENAI_API_KEY: "x", GEMINI_API_KEY: "x", PERPLEXITY_API_KEY: "x", ANTHROPIC_API_KEY: "x" };
  const audit = await runAnswerAudit(input, env, fetchMock);
  assert.equal(audit.status, "complete");
  assert.equal(audit.results.length, 20);
  assert.equal(audit.summary.observed, 20);
  assert.equal(audit.summary.cited, 20);
  assert.deepEqual(audit.queryContext, { brand: "Buick or GMC", city: "Example City", state: "AL" });
  assert.equal(audit.summary.aiScore, 25);
  assert.equal(audit.summary.levelsPassedCount, 5);
});
