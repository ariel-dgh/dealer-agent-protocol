import { auditWebsiteReadiness, isValidPublicUrl } from "./dealer-ai-visibility-audit.mjs";
import { ANSWER_AUDIT_VERSION, LOVABLE_ANSWER_AUDIT_URL, runLovableAnswerAudit } from "./dealer-ai-visibility-answer-audit.mjs";

const SUPABASE_URL = "https://dvnkcofnkmthlbhrkffl.supabase.co";
const MAX_BODY_BYTES = 16_384;
const ANSWER_AUDIT_DAILY_LIMIT = 3;

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' https://www.google-analytics.com https://region1.google-analytics.com",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self' https://www.googletagmanager.com",
    "style-src 'self'",
    "upgrade-insecure-requests",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
  });
}

function clean(value, limit = 300) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 200;
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (!isValidPublicUrl(url.toString())) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || "0");
  if (length > MAX_BODY_BYTES) throw new Error("body_too_large");
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) throw new Error("unsupported_media_type");
  return request.json();
}

function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

async function supabase(env, path, { method = "POST", body, timeout = 60_000, auth = true } = {}) {
  if (!env.SUPABASE_ANON_KEY) throw new Error("backend_not_configured");
  const headers = { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${env.SUPABASE_ANON_KEY}`;
  return fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
}

async function scan(request, env, url) {
  if (request.method !== "POST") return json({ message: "Method not allowed." }, 405);
  if (!sameOrigin(request, url)) return json({ message: "Origin not allowed." }, 403);
  let input;
  try { input = await readJson(request); } catch (error) { return json({ message: error.message }, error.message === "body_too_large" ? 413 : 415); }
  if (clean(input.website_company, 200)) return json({ message: "Request accepted." }, 202);

  const dealershipName = clean(input.dealershipName, 160);
  const city = clean(input.city, 120);
  const homepageUrl = publicUrl(clean(input.homepageUrl));
  const competitorInput = clean(input.competitorUrl);
  const competitorUrl = competitorInput ? publicUrl(competitorInput) : null;
  if (!dealershipName || !city || !homepageUrl || (competitorInput && !competitorUrl)) return json({ message: "Enter a valid dealership name, city and state, and public website URL." }, 400);
  try {
    const response = await supabase(env, "/functions/v1/analyze-ai-visibility", { body: { dealershipName, city, homepageUrl, competitorUrl } });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return json({ message: result.message || result.error || "The scan provider returned an error." }, response.status >= 500 ? 502 : response.status);
    const shortId = clean(result.shortId || result.short_id || result.report?.short_id, 20);
    let answerAudit = { status: "not_configured" };
    if (shortId) {
      try {
        answerAudit = await scheduleAnswerAudit({ shortId, dealershipName, city, homepageUrl }, request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "answer_audit_schedule_failed", reportShortId: shortId, error: error?.message || String(error) }));
        answerAudit = { status: "unavailable", message: "The live Answer Audit could not be scheduled. The baseline report is still available." };
      }
    }
    return json({ ...result, answer_audit: answerAudit });
  } catch (error) {
    return json({ message: error.name === "TimeoutError" ? "The scan timed out. Please try again." : "The scan is temporarily unavailable." }, 503);
  }
}

function answerAuditConfigured(env) {
  return Boolean(env.AUDIT_DB && env.ANSWER_AUDIT_QUEUE);
}

function parseStoredJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

async function hashAddress(value) {
  const bytes = new TextEncoder().encode(String(value || "unknown"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeAnswerAuditAllowance(request, env) {
  const ipHash = await hashAddress(request.headers.get("CF-Connecting-IP") || "unknown");
  const day = new Date().toISOString().slice(0, 10);
  return env.AUDIT_DB.prepare(`
    INSERT INTO answer_audit_rate_limits (ip_hash, day, runs, updated_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(ip_hash, day) DO UPDATE SET runs = runs + 1, updated_at = datetime('now')
    WHERE answer_audit_rate_limits.runs < ?
    RETURNING runs
  `).bind(ipHash, day, ANSWER_AUDIT_DAILY_LIMIT).first();
}

async function scheduleAnswerAudit(input, request, env) {
  if (!answerAuditConfigured(env)) return { status: "not_configured" };
  const recent = await env.AUDIT_DB.prepare(`
    SELECT id, status, vehicle_context_json, summary_json, completed_at
    FROM answer_audit_jobs
    WHERE domain = ? AND methodology_version = ?
      AND status IN ('complete', 'partial')
      AND completed_at >= datetime('now', '-24 hours')
    ORDER BY completed_at DESC LIMIT 1
  `).bind(new URL(input.homepageUrl).hostname.replace(/^www\./, ""), ANSWER_AUDIT_VERSION).first();
  const jobId = crypto.randomUUID();
  const domain = new URL(input.homepageUrl).hostname.replace(/^www\./, "");
  if (recent) {
    await env.AUDIT_DB.batch([
      env.AUDIT_DB.prepare(`
        INSERT INTO answer_audit_jobs
          (id, report_short_id, domain, dealership_name, city, homepage_url, status, methodology_version, source_job_id, vehicle_context_json, summary_json, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).bind(jobId, input.shortId, domain, input.dealershipName, input.city, input.homepageUrl, recent.status, ANSWER_AUDIT_VERSION, recent.id, recent.vehicle_context_json, recent.summary_json),
      env.AUDIT_DB.prepare(`
        INSERT INTO answer_audit_results
          (job_id, question_id, dimension, provider, provider_label, model, prompt, status, answer, citations_json, observed_at, latency_ms, error_code, assessment_json)
        SELECT ?, question_id, dimension, provider, provider_label, model, prompt, status, answer, citations_json, observed_at, latency_ms, error_code, assessment_json
        FROM answer_audit_results WHERE job_id = ?
      `).bind(jobId, recent.id),
    ]);
    return { status: recent.status, reportShortId: input.shortId, reused: true, completedAt: recent.completed_at };
  }
  const allowance = await consumeAnswerAuditAllowance(request, env);
  if (!allowance) return { status: "rate_limited", message: "The daily live Answer Audit limit has been reached. The baseline report is still available." };
  await env.AUDIT_DB.prepare(`
    INSERT INTO answer_audit_jobs
      (id, report_short_id, domain, dealership_name, city, homepage_url, status, methodology_version)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
  `).bind(jobId, input.shortId, domain, input.dealershipName, input.city, input.homepageUrl, ANSWER_AUDIT_VERSION).run();
  try {
    await env.ANSWER_AUDIT_QUEUE.send({ jobId });
  } catch (error) {
    await env.AUDIT_DB.prepare("UPDATE answer_audit_jobs SET status = 'failed', error_code = 'queue_send_failed', completed_at = datetime('now') WHERE id = ?").bind(jobId).run();
    throw error;
  }
  return { status: "queued", reportShortId: input.shortId };
}

async function answerAudit(shortId, env) {
  if (!/^[a-z0-9]{6,20}$/i.test(shortId)) return { status: "invalid" };
  if (!env.AUDIT_DB) return { status: "not_configured" };
  try {
    const job = await env.AUDIT_DB.prepare(`
      SELECT id, report_short_id, domain, status, methodology_version, vehicle_context_json,
        summary_json, error_code, created_at, started_at, completed_at
      FROM answer_audit_jobs WHERE report_short_id = ? LIMIT 1
    `).bind(shortId).first();
    if (!job) return { status: answerAuditConfigured(env) ? "not_started" : "not_configured" };
    let results = [];
    if (["complete", "partial", "unavailable"].includes(job.status)) {
      const query = await env.AUDIT_DB.prepare(`
        SELECT question_id, dimension, provider, provider_label, model, prompt, status, answer,
          citations_json, observed_at, latency_ms, error_code, assessment_json
        FROM answer_audit_results WHERE job_id = ? ORDER BY question_id
      `).bind(job.id).all();
      results = (query.results || []).map((row) => ({
        questionId: row.question_id,
        dimension: row.dimension,
        provider: row.provider,
        providerLabel: row.provider_label,
        model: row.model,
        prompt: row.prompt,
        status: row.status,
        answer: row.answer,
        citations: parseStoredJson(row.citations_json, []),
        observedAt: row.observed_at,
        latencyMs: row.latency_ms,
        errorCode: row.error_code,
        assessment: parseStoredJson(row.assessment_json, null),
      }));
    }
    return {
      status: job.status,
      version: job.methodology_version,
      reportShortId: job.report_short_id,
      queryContext: parseStoredJson(job.vehicle_context_json, null),
      summary: parseStoredJson(job.summary_json, null),
      errorCode: job.error_code,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      results,
      notice: "Automated public-web observations are evidence for review, not a guarantee of factual accuracy or current availability.",
    };
  } catch (error) {
    console.error(JSON.stringify({ event: "answer_audit_read_failed", reportShortId: shortId, error: error?.message || String(error) }));
    return { status: "unavailable", message: "Live Answer Audit evidence is temporarily unavailable." };
  }
}

async function processAnswerAuditMessage(message, env) {
  const jobId = clean(message.body?.jobId, 80);
  if (!jobId) { message.ack(); return; }
  const job = await env.AUDIT_DB.prepare(`
    SELECT id, report_short_id, dealership_name, city, homepage_url, status
    FROM answer_audit_jobs WHERE id = ? LIMIT 1
  `).bind(jobId).first();
  if (!job || ["complete", "partial", "unavailable"].includes(job.status)) { message.ack(); return; }
  try {
    await env.AUDIT_DB.prepare("UPDATE answer_audit_jobs SET status = 'running', started_at = COALESCE(started_at, datetime('now')), error_code = NULL WHERE id = ?").bind(jobId).run();
    const audit = await runLovableAnswerAudit(
      { dealershipName: job.dealership_name, city: job.city, homepageUrl: job.homepage_url },
      fetch,
      env.LOVABLE_ANSWER_AUDIT_URL || LOVABLE_ANSWER_AUDIT_URL,
    );
    const statements = audit.results.map((row) => env.AUDIT_DB.prepare(`
      INSERT OR REPLACE INTO answer_audit_results
        (job_id, question_id, dimension, provider, provider_label, model, prompt, status, answer, citations_json, observed_at, latency_ms, error_code, assessment_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(jobId, row.questionId, row.dimension, row.provider, row.providerLabel, row.model, row.prompt, row.status, row.answer, JSON.stringify(row.citations), row.observedAt, row.latencyMs, row.errorCode, JSON.stringify(row.assessment)));
    statements.push(env.AUDIT_DB.prepare(`
      UPDATE answer_audit_jobs SET status = ?, methodology_version = ?, vehicle_context_json = ?, summary_json = ?, completed_at = datetime('now'), error_code = NULL
      WHERE id = ?
    `).bind(audit.status, audit.version, JSON.stringify(audit.queryContext), JSON.stringify(audit.summary), jobId));
    await env.AUDIT_DB.batch(statements);
    console.log(JSON.stringify({ event: "answer_audit_completed", jobId, reportShortId: job.report_short_id, status: audit.status, observed: audit.summary.observed, total: audit.summary.total }));
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({ event: "answer_audit_job_failed", jobId, attempt: message.attempts, error: error?.message || String(error) }));
    if (message.attempts >= 3) {
      await env.AUDIT_DB.prepare("UPDATE answer_audit_jobs SET status = 'failed', error_code = 'job_failed', completed_at = datetime('now') WHERE id = ?").bind(jobId).run();
      message.ack();
    } else {
      message.retry({ delaySeconds: 60 });
    }
  }
}

async function websiteReadiness(homepageUrl, context) {
  const safeUrl = publicUrl(homepageUrl);
  if (!safeUrl) return { status: "unavailable", message: "The stored homepage URL is not eligible for a public scan." };
  const cacheKey = new Request(`https://readiness-cache.dealeraivisibility.com/v20260905b/${encodeURIComponent(safeUrl)}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) return cached.json();
  try {
    const result = await auditWebsiteReadiness(safeUrl);
    if (cache) {
      const response = new Response(JSON.stringify(result), { headers: { "Cache-Control": "public, max-age=86400", "Content-Type": "application/json" } });
      if (context?.waitUntil) context.waitUntil(cache.put(cacheKey, response));
      else await cache.put(cacheKey, response);
    }
    return result;
  } catch {
    return { status: "unavailable", message: "Website-readiness evidence could not be collected during this request." };
  }
}

function publicReport(value) {
  const allowed = [
    "id", "short_id", "domain", "homepage_url", "competitor_domain", "dealership_name",
    "city", "overall_score", "category_scores", "platform_scores", "findings", "created_at",
  ];
  return Object.fromEntries(allowed.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

async function report(shortId, env, context) {
  if (!/^[a-z0-9]{6,20}$/i.test(shortId)) return json({ message: "Invalid report ID." }, 400);
  try {
    const response = await supabase(env, "/rest/v1/rpc/get_report_by_short_id", { body: { p_short_id: shortId }, timeout: 15_000 });
    const result = await response.json().catch(() => null);
    const value = Array.isArray(result) ? result[0] : result;
    if (!response.ok) return json({ message: "Report provider error." }, 502);
    if (!value) return json({ message: "Report not found." }, 404);
    const readiness = await websiteReadiness(value.homepage_url, context);
    const liveAnswerAudit = await answerAudit(shortId, env);
    return json({ ...publicReport(value), website_readiness: readiness, answer_audit: liveAnswerAudit });
  } catch {
    return json({ message: "The report is temporarily unavailable." }, 503);
  }
}

async function premium(request, env, url) {
  if (request.method !== "POST") return json({ message: "Method not allowed." }, 405);
  if (!sameOrigin(request, url)) return json({ message: "Origin not allowed." }, 403);
  let input;
  try { input = await readJson(request); } catch (error) { return json({ message: error.message }, 400); }
  const email = clean(input.email, 200).toLowerCase();
  const dealershipName = clean(input.dealershipName, 160);
  if (!validEmail(email) || !dealershipName) return json({ message: "Enter a valid work email and dealership." }, 400);
  const payload = {
    email,
    dealershipName,
    phone: clean(input.phone, 50) || null,
    reportId: clean(input.reportId, 80) || null,
    reportShortId: clean(input.reportShortId, 30) || null,
    domain: clean(input.domain, 200) || null,
    city: clean(input.city, 120) || null,
    overallScore: Number.isFinite(Number(input.overallScore)) ? Number(input.overallScore) : null,
  };
  try {
    const response = await supabase(env, "/functions/v1/submit-premium-analysis", { body: payload, timeout: 15_000 });
    const result = await response.json().catch(() => ({}));
    return response.ok ? json(result) : json({ message: result.message || "Could not save the request." }, 502);
  } catch { return json({ message: "Could not save the request." }, 503); }
}

async function unsubscribe(request, env, url) {
  if (request.method === "GET") {
    const token = clean(url.searchParams.get("token"), 500);
    if (!token) return json({ valid: false }, 400);
    try {
      const response = await supabase(env, `/functions/v1/handle-email-unsubscribe?token=${encodeURIComponent(token)}`, { method: "GET", timeout: 12_000, auth: false });
      return new Response(response.body, { status: response.status, headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
    } catch { return json({ valid: false }, 503); }
  }
  if (request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ message: "Origin not allowed." }, 403);
    let input;
    try { input = await readJson(request); } catch { return json({ message: "Invalid request." }, 400); }
    const token = clean(input.token, 500);
    if (!token) return json({ message: "Invalid token." }, 400);
    try {
      const response = await supabase(env, "/functions/v1/handle-email-unsubscribe", { body: { token }, timeout: 12_000 });
      return new Response(response.body, { status: response.status, headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
    } catch { return json({ message: "Request unavailable." }, 503); }
  }
  return json({ message: "Method not allowed." }, 405);
}

function escapeMeta(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function reportPage(request, env, shortId) {
  let reportData = null;
  try {
    const response = await supabase(env, "/rest/v1/rpc/get_report_by_short_id", { body: { p_short_id: shortId }, timeout: 10_000 });
    const result = await response.json();
    reportData = Array.isArray(result) ? result[0] : result;
  } catch { /* client will retry through the first-party API */ }

  const assetUrl = new URL("/report/index.html", request.url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl, { headers: request.headers }));
  let html = await asset.text();
  const name = reportData?.dealership_name || reportData?.domain || "Dealership";
  const score = Number(reportData?.overall_score ?? 0);
  const title = reportData ? `${name} AI visibility score: ${score}/100` : "Dealer AI visibility report";
  const description = reportData ? `${name} scored ${score}/100 on public signals that help AI systems understand and recommend a dealership.` : "A public dealership AI visibility report.";
  const canonical = `https://dealeraivisibility.com/report/${shortId}`;
  const image = reportData ? `${SUPABASE_URL}/functions/v1/og-report?shortId=${encodeURIComponent(shortId)}` : "https://dealeraivisibility.com/og.png";
  const replacements = { "{{REPORT_TITLE}}": title, "{{REPORT_DESCRIPTION}}": description, "{{REPORT_CANONICAL}}": canonical, "{{REPORT_IMAGE}}": image };
  for (const [token, value] of Object.entries(replacements)) html = html.replaceAll(token, escapeMeta(value));
  return new Response(html, { status: 200, headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=300", "Content-Type": "text/html; charset=utf-8" } });
}

function secureAsset(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  const isHtml = headers.get("Content-Type")?.includes("text/html");
  headers.set("Cache-Control", isHtml ? "public, max-age=0, must-revalidate" : "public, max-age=3600");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.hostname === "www.dealeraivisibility.com") {
      url.hostname = "dealeraivisibility.com";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/api/scan") return scan(request, env, url);
    if (url.pathname === "/api/premium") return premium(request, env, url);
    if (url.pathname === "/api/unsubscribe") return unsubscribe(request, env, url);
    if (url.pathname.startsWith("/api/answer-audit/")) return json(await answerAudit(url.pathname.split("/").filter(Boolean).pop(), env));
    if (url.pathname.startsWith("/api/report/")) return report(url.pathname.split("/").filter(Boolean).pop(), env, context);

    const reportMatch = url.pathname.match(/^\/report\/([a-z0-9]{6,20})\/?$/i);
    if (reportMatch) return reportPage(request, env, reportMatch[1]);
    const shortMatch = url.pathname.match(/^\/r\/([a-z0-9]{6,20})\/?$/i);
    if (shortMatch) return Response.redirect(`https://dealeraivisibility.com/report/${shortMatch[1]}`, 301);

    return secureAsset(await env.ASSETS.fetch(request));
  },
  async queue(batch, env) {
    for (const message of batch.messages) await processAnswerAuditMessage(message, env);
  },
};
