import test from "node:test";
import assert from "node:assert/strict";
import {
  ANSWER_AUDIT_QUESTIONS,
  ANSWER_AUDIT_LEVELS,
  assessAnswer,
  deriveBrand,
  extractVehicleContext,
  materializeQuestion,
  normalizeLovableAnswerAudit,
  parseAnthropic,
  parseGemini,
  parseOpenAI,
  parseMarket,
  parsePerplexity,
  runAnswerAudit,
  runLovableAnswerAudit,
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

function lovableFixture() {
  const engines = ["OpenAI ChatGPT", "Google Gemini", "Claude", "Perplexity"];
  return {
    aiScore: 25,
    levels: ANSWER_AUDIT_LEVELS.map((level) => ({
      level: level.level,
      name: level.label,
      passed: true,
      points: level.points,
      maxPoints: level.points,
      query: level.question.replaceAll("{brand}", "Buick or GMC").replaceAll("{city}", "Example City").replaceAll("{state}", "AL"),
      engineResults: engines.map((engine) => ({ engine, mentioned: true, response: "Example Buick GMC is recommended. See https://exampledealer.com/.", confidence: 1 })),
    })),
    engineHealth: engines.map((engine) => ({ engine, status: "ok", successes: 5, errorCodes: [] })),
    timestamp: "2026-09-06T03:00:00.000Z",
  };
}

test("Lovable audit output is normalized into 20 stable evidence rows", () => {
  const audit = normalizeLovableAnswerAudit(lovableFixture(), input);
  assert.equal(audit.status, "complete");
  assert.equal(audit.results.length, 20);
  assert.equal(audit.summary.observed, 20);
  assert.equal(audit.summary.mentioned, 20);
  assert.equal(audit.summary.aiScore, 25);
  assert.equal(audit.summary.cited, 20);
  assert.equal(audit.results[0].model, "gpt-4o-mini");
  assert.equal(audit.results[0].observedAt, "2026-09-06T03:00:00.000Z");
  assert.match(audit.notice, /does not return a structured citation list/);
});

test("Lovable provider failures stay unavailable and never become negative mentions", () => {
  const fixture = lovableFixture();
  fixture.levels.forEach((level) => {
    const claude = level.engineResults.find((item) => item.engine === "Claude");
    Object.assign(claude, { mentioned: false, response: "Error: request timed out", unavailable: true, confidence: 0 });
  });
  fixture.engineHealth.find((item) => item.engine === "Claude").status = "unavailable";
  fixture.engineHealth.find((item) => item.engine === "Claude").successes = 0;
  fixture.engineHealth.find((item) => item.engine === "Claude").errorCodes = ["TIMEOUT"];
  const audit = normalizeLovableAnswerAudit(fixture, input);
  const claudeRows = audit.results.filter((item) => item.provider === "anthropic");
  assert.equal(claudeRows.every((item) => item.status === "unavailable"), true);
  assert.equal(claudeRows.every((item) => item.errorCode === "timeout"), true);
  assert.equal(audit.summary.providers.find((item) => item.provider === "anthropic").status, "unavailable");
});

test("Lovable's zero-success health bug cannot display a green provider", () => {
  const fixture = lovableFixture();
  fixture.levels.forEach((level) => {
    const gemini = level.engineResults.find((item) => item.engine === "Google Gemini");
    Object.assign(gemini, { mentioned: false, response: "", unavailable: true, confidence: 0 });
  });
  const health = fixture.engineHealth.find((item) => item.engine === "Google Gemini");
  Object.assign(health, { status: "ok", successes: 0, errorCodes: [] });
  const audit = normalizeLovableAnswerAudit(fixture, input);
  assert.equal(audit.summary.providers.find((item) => item.provider === "gemini").status, "unavailable");
});

test("Lovable's weak generic-word match cannot create a false dealer mention", () => {
  const fixture = lovableFixture();
  fixture.levels.forEach((level) => {
    const openai = level.engineResults.find((item) => item.engine === "OpenAI ChatGPT");
    Object.assign(openai, { mentioned: true, response: "This answer mentions a dealer but not the measured business.", confidence: 0.6 });
  });
  const audit = normalizeLovableAnswerAudit(fixture, input);
  assert.equal(audit.results.filter((item) => item.provider === "openai").every((item) => item.status === "not_mentioned"), true);
  assert.equal(audit.summary.providers.find((item) => item.provider === "openai").status, "ok");
});

test("Lovable adapter sends only dealer context and no provider credentials", async () => {
  let captured;
  const fetchMock = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify(lovableFixture()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const audit = await runLovableAnswerAudit(input, fetchMock, "https://audit.example/functions/v1/test-ai-visibility");
  assert.equal(captured.url, "https://audit.example/functions/v1/test-ai-visibility");
  assert.deepEqual(captured.body, { brand: "Buick or GMC", domain: "exampledealer.com", city: "Example City", state: "AL", dealershipName: "Example Buick GMC" });
  assert.deepEqual(Object.keys(captured.init.headers), ["Content-Type"]);
  assert.equal(audit.results.length, 20);
});
