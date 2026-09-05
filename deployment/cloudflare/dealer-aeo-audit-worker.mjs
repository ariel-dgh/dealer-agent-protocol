const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' https://www.google-analytics.com https://analytics.google.com",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https://www.google-analytics.com",
    "object-src 'none'",
    "script-src 'self' https://www.googletagmanager.com",
    "style-src 'self'",
    "upgrade-insecure-requests",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const MAX_BODY_BYTES = 20_480;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
}

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 200;
}

function validWebsite(value, optional = false) {
  if (optional && !value) return true;
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) && parsed.hostname.includes(".");
  } catch {
    return false;
  }
}

async function readBody(request) {
  const length = Number(request.headers.get("Content-Length") || "0");
  if (length > MAX_BODY_BYTES) throw new Error("body_too_large");
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) return request.json();
  if (contentType.includes("multipart/form-data")) return Object.fromEntries(await request.formData());
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("body_too_large");
    return Object.fromEntries(new URLSearchParams(text));
  }
  throw new Error("unsupported_media_type");
}

async function submitAudit(request, env, url) {
  if (request.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST for audit requests." }, 405);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "origin_not_allowed", message: "This form can only be submitted from the audit site." }, 403);
  if (!env.AUDIT_DB) return json({ error: "temporarily_unavailable", message: "Audit requests are temporarily unavailable." }, 503);

  let input;
  try { input = await readBody(request); }
  catch (error) {
    const tooLarge = error?.message === "body_too_large";
    return json({ error: error?.message || "invalid_request", message: tooLarge ? "The request is too large." : "The request format is not supported." }, tooLarge ? 413 : 415);
  }

  const wantsHtml = !request.headers.get("Accept")?.includes("application/json");
  if (clean(input.website_company, 200)) {
    return wantsHtml ? Response.redirect(`${url.origin}/?submitted=1#audit-request`, 303) : json({ accepted: true }, 201);
  }

  const application = {
    contactName: clean(input.contact_name, 120),
    workEmail: clean(input.work_email, 200).toLowerCase(),
    dealershipName: clean(input.dealership_name, 180),
    dealershipWebsite: clean(input.dealership_website, 300),
    role: clean(input.role, 120),
    rooftopCount: clean(input.rooftop_count, 20),
    market: clean(input.market, 120),
    websiteProvider: clean(input.website_provider, 120) || null,
    auditTrigger: clean(input.audit_trigger, 40),
    visibilityReportUrl: clean(input.visibility_report_url, 400) || null,
    auditGoal: clean(input.audit_goal, 1600),
    sourcePath: clean(input.source_path, 160) || "/",
  };
  const consent = [true, "true", "on", "1"].includes(input.consent);
  const validRooftops = new Set(["1", "2-5", "6-20", "21+"]);
  const validTriggers = new Set(["visibility-scan", "vendor-claim", "missed-recommendation", "wrong-answer", "technical-review", "other"]);
  const fields = {};
  if (!application.contactName) fields.contact_name = "Enter your name.";
  if (!validEmail(application.workEmail)) fields.work_email = "Enter a valid work email.";
  if (!application.dealershipName) fields.dealership_name = "Enter the dealership or group name.";
  if (!validWebsite(application.dealershipWebsite)) fields.dealership_website = "Enter a complete dealership website URL.";
  if (!application.role) fields.role = "Enter your role.";
  if (!validRooftops.has(application.rooftopCount)) fields.rooftop_count = "Select the rooftop count.";
  if (!application.market) fields.market = "Enter the primary market.";
  if (!validTriggers.has(application.auditTrigger)) fields.audit_trigger = "Select a valid starting point.";
  if (!validWebsite(application.visibilityReportUrl, true)) fields.visibility_report_url = "Enter a valid report URL or leave it blank.";
  if (application.auditGoal.length < 20) fields.audit_goal = "Explain the audit goal in at least 20 characters.";
  if (!consent) fields.consent = "Consent is required.";
  if (Object.keys(fields).length) return json({ error: "validation_failed", message: "Review the highlighted information and try again.", fields }, 400);

  const duplicate = await env.AUDIT_DB.prepare("SELECT COUNT(*) AS total FROM audit_applications WHERE work_email = ?1 AND created_at > datetime('now', '-1 hour')").bind(application.workEmail).first();
  if (Number(duplicate?.total || 0) >= 3) return json({ error: "rate_limited", message: "Too many recent requests for this email. Try again later." }, 429);

  const id = crypto.randomUUID();
  try {
    await env.AUDIT_DB.prepare(`INSERT INTO audit_applications (
      id, contact_name, work_email, dealership_name, dealership_website, role,
      rooftop_count, market, audit_goal, consent, source_path, website_provider,
      audit_trigger, visibility_report_url
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12, ?13)`)
      .bind(id, application.contactName, application.workEmail, application.dealershipName, application.dealershipWebsite, application.role, application.rooftopCount, application.market, application.auditGoal, application.sourcePath, application.websiteProvider, application.auditTrigger, application.visibilityReportUrl)
      .run();
  } catch (error) {
    console.error("audit_application_not_saved", error);
    return json({ error: "application_not_saved", message: "The request could not be saved. Please try again." }, 500);
  }

  if (wantsHtml) return Response.redirect(`${url.origin}/?submitted=1#audit-request`, 303);
  return json({ accepted: true, application_id: id }, 201);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "www.dealeraeoaudit.com") {
      url.hostname = "dealeraeoaudit.com";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/api/audit-applications") return submitAudit(request, env, url);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    const isHtml = headers.get("Content-Type")?.includes("text/html");
    headers.set("Cache-Control", isHtml ? "public, max-age=0, must-revalidate" : "public, max-age=3600");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
