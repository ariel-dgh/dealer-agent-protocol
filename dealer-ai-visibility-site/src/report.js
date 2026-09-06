(() => {
  const reportId = location.pathname.split("/").filter(Boolean).pop();
  const loading = document.querySelector("#report-loading");
  const errorBox = document.querySelector("#report-error");
  const content = document.querySelector("#report-content");
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
  const titleCase = (value) => String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (char) => char.toUpperCase());
  const scoreBand = (score) => score >= 80 ? ["STRONG VISIBILITY", "Your dealership is legible to AI. The opportunity is to widen the lead and connect inventory facts directly.", "You are visible. Now make the answer unmistakable."] : score >= 60 ? ["PARTIALLY VISIBLE", "AI can find the dealership, but missing evidence may keep it from being cited or recommended consistently.", "You are in the conversation—not yet in control of it."] : score >= 40 ? ["WEAK VISIBILITY", "Important signals are incomplete or difficult for AI systems to interpret with confidence.", "Competitors may be winning the answer by default."] : ["LOW VISIBILITY", "AI systems have too little reliable public evidence to understand and recommend this dealership.", "Your dealership is present on the web but absent from the answer."];
  const safeLink = (value) => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.toString() : ""; } catch { return ""; } };

  function scoreCards(scores, labels) {
    return Object.entries(labels).map(([key, label]) => {
      const value = Math.max(0, Math.min(100, Number(scores?.[key] ?? 0)));
      return `<article class="score-card" style="--score:${value}%"><div class="score-row"><h3>${escapeHtml(label)}</h3><strong>${value}</strong></div><div class="meter"><i></i></div><small>${value >= 80 ? "strong signal" : value >= 60 ? "visible gap" : value >= 40 ? "needs attention" : "priority weakness"}</small></article>`;
    }).join("");
  }

  function findingCard(finding, index) {
    const severity = String(finding.severity || finding.impact || "medium").toLowerCase();
    const platforms = Array.isArray(finding.platforms) ? finding.platforms.map(titleCase).join(", ") : "Multiple AI systems";
    return `<article class="finding${index === 0 ? " open" : ""}"><div class="finding-head"><span class="severity ${escapeHtml(severity)}">${escapeHtml(severity)}</span><h3>${escapeHtml(finding.title || "Visibility finding")}</h3><button class="finding-toggle" type="button" aria-expanded="${index === 0}">${index === 0 ? "CLOSE −" : "OPEN +"}</button></div><div class="finding-body"><div><b>WHAT WE FOUND</b><p>${escapeHtml(finding.foundSnippet || "The scan found an incomplete public signal.")}</p></div><div><b>WHY IT MATTERS</b><p>${escapeHtml(finding.whyItMatters || `This can affect visibility across ${platforms}.`)}</p></div><div><b>WHAT TO DO</b><p>${escapeHtml(finding.howToFix || "Review and strengthen this signal on the dealership website.")}</p></div></div></article>`;
  }

  function readinessPillar(key, pillar) {
    const labels = { schema: "Schema markup", discoverability: "Page discoverability", fileReadiness: "AI file readiness" };
    const checks = Array.isArray(pillar?.checks) ? pillar.checks : [];
    return `<article class="readiness-pillar"><div class="readiness-pillar-head"><div><span>${escapeHtml(labels[key] || titleCase(key))}</span><small>${Number(pillar?.score || 0)} / ${Number(pillar?.maxScore || 25)} points</small></div><strong>${Number(pillar?.score || 0)}</strong></div><div class="evidence-list">${checks.map((item) => {
      const status = ["pass", "partial", "fail", "unavailable", "not_applicable"].includes(item.status) ? item.status : "unavailable";
      const statusLabel = { pass: "Observed", partial: "Partial", fail: "Missing", unavailable: "Unavailable", not_applicable: "Optional" }[status];
      const points = Number(item.maxPoints) > 0 ? `${Number(item.points || 0)}/${Number(item.maxPoints)} pts` : "Not scored";
      return `<div class="evidence-row"><span class="evidence-status ${status}">${statusLabel}</span><div><b>${escapeHtml(item.label || "Signal")}</b><p>${escapeHtml(item.evidence || "No evidence detail returned.")}</p></div><small>${points}</small></div>`;
    }).join("")}</div></article>`;
  }

  function renderReadiness(readiness) {
    const target = document.querySelector("#readiness-content");
    if (!readiness || readiness.status === "unavailable" || !readiness.pillars) {
      target.innerHTML = `<div class="truth-note warning"><b>EVIDENCE UNAVAILABLE</b><p>${escapeHtml(readiness?.message || "The website could not be re-observed for this report. No technical result has been inferred.")}</p></div>`;
      return;
    }
    const observed = readiness.observedAt ? new Date(readiness.observedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "this report load";
    const complete = readiness.status === "complete";
    const score = complete ? Number(readiness.score || 0) : "—";
    const summary = complete ? `<b>Grade ${escapeHtml(readiness.grade || "—")}</b><br>${Number(readiness.rawScore || 0)} of ${Number(readiness.maxRawScore || 75)} documented points observed.` : `<b>Partial observation—no grade assigned</b><br>${Number(readiness.rawScore || 0)} points were verifiable, but one or more required resources could not be observed reliably.`;
    target.innerHTML = `<div class="readiness-summary"><div><span>TECHNICAL READINESS</span><strong>${score}<small>/100</small></strong></div><p>${summary}<br>Re-checked ${escapeHtml(observed)}.</p></div><div class="readiness-grid">${Object.entries(readiness.pillars).map(([key, pillar]) => readinessPillar(key, pillar)).join("")}</div>`;
  }

  function auditStatusLabel(status) {
    return ({ mentioned: "Dealer mentioned", not_mentioned: "Not mentioned", unavailable: "Unavailable", ok: "Operational", degraded: "Partial", not_configured: "Not configured" })[status] || titleCase(status);
  }

  function answerResultCard(result) {
    const levelId = String(result.questionId || "").split("-")[0];
    const observed = result.observedAt ? new Date(result.observedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "No timestamp returned";
    const citations = Array.isArray(result.citations) ? result.citations.filter((item) => safeLink(item?.url)) : [];
    const sourceList = citations.length ? `<ol class="answer-sources">${citations.map((item) => `<li><a href="${escapeHtml(safeLink(item.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || new URL(item.url).hostname)}</a></li>`).join("")}</ol>` : `<p class="answer-no-sources">No usable source URL was returned.</p>`;
    const answer = result.status === "unavailable" ? `<p class="answer-unavailable">This provider could not be observed for this question. It is excluded from negative-mention counts.${result.errorCode ? ` Reason: ${escapeHtml(titleCase(result.errorCode))}.` : ""}</p>` : `<blockquote>${escapeHtml(result.answer || "No answer text returned.")}</blockquote>`;
    return `<details class="answer-result ${escapeHtml(result.status)}"><summary><span class="answer-id">${escapeHtml(levelId)}</span><span class="answer-provider">${escapeHtml(result.providerLabel)}</span><strong>${escapeHtml(auditStatusLabel(result.status))}</strong><span class="answer-question">${escapeHtml(String(result.prompt || "").split("\n")[0])}</span></summary><div class="answer-result-body"><div class="answer-evidence"><b>OBSERVED ANSWER</b>${answer}</div><div class="answer-proof"><div><b>OBSERVED</b><p>${escapeHtml(observed)}</p></div><div><b>MODEL</b><p>${escapeHtml(result.model || "Not returned")}</p></div><div><b>SOURCES</b>${sourceList}</div></div><details class="exact-prompt"><summary>View exact recorded prompt</summary><pre>${escapeHtml(result.prompt || "")}</pre></details></div></details>`;
  }

  function renderAnswerAudit(audit) {
    const target = document.querySelector("#answer-audit-content");
    if (!target) return;
    const status = audit?.status || "not_started";
    if (["queued", "running", "not_started"].includes(status)) {
      target.innerHTML = `<div class="answer-audit-running"><span class="live-indicator"><i></i></span><div><b>${status === "running" ? "OBSERVING LIVE ANSWERS" : "ANSWER AUDIT QUEUED"}</b><p>The baseline report is ready. The 20 live checks run separately so a slow provider cannot delay this page. This section updates automatically.</p></div></div>`;
      return;
    }
    if (status === "rate_limited") {
      target.innerHTML = `<div class="truth-note warning"><b>DAILY LIMIT REACHED</b><p>${escapeHtml(audit.message || "The live checks were not run. The baseline report remains available.")}</p></div>`;
      return;
    }
    if (status === "not_configured") {
      target.innerHTML = `<div class="truth-note warning"><b>LIVE AUDIT NOT ACTIVATED</b><p>This report contains the technical baseline only. No live provider answers were collected, so no answer-engine result is inferred.</p></div>`;
      return;
    }
    if (["failed", "invalid"].includes(status)) {
      target.innerHTML = `<div class="truth-note warning"><b>OBSERVATION FAILED</b><p>The live audit did not complete. Provider failures are not counted as negative mentions. The technical baseline above remains valid.</p></div>`;
      return;
    }
    const summary = audit.summary;
    const results = Array.isArray(audit.results) ? audit.results : [];
    if (!summary || !results.length) {
      target.innerHTML = `<div class="truth-note warning"><b>EVIDENCE UNAVAILABLE</b><p>${escapeHtml(audit?.message || "No live answer evidence is available for this report.")}</p></div>`;
      return;
    }
    const providers = (summary.providers || []).map((provider) => `<article class="provider-health ${escapeHtml(provider.status)}"><span><i></i>${escapeHtml(provider.label)}</span><strong>${provider.successes}/${provider.total}</strong><small>${escapeHtml(auditStatusLabel(provider.status))}</small></article>`).join("");
    const completedAt = audit.completedAt ? new Date(audit.completedAt).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }) : "Timestamp unavailable";
    const queryContext = audit.queryContext || {};
    const context = `Brand context: ${queryContext.brand || "vehicle"}. Market: ${[queryContext.city, queryContext.state].filter(Boolean).join(", ") || "local area"}. Five buyer-intent levels were each tested across four providers.`;
    const dimensions = [...new Set(results.map((item) => item.dimension))];
    target.innerHTML = `<div class="answer-audit-summary"><div class="answer-audit-score"><span>LIVE VISIBILITY</span><strong>${Number(summary.aiScore || 0)}<small>/ ${Number(summary.maxAiScore || 25)}</small></strong><p>${Number(summary.levelsPassedCount || 0)} of 5 intent levels passed</p></div><div class="answer-audit-facts"><div><b>${Number(summary.observed || 0)}</b><span>provider answers observed</span></div><div><b>${Number(summary.mentioned || 0)}</b><span>dealer mentions</span></div><div><b>${Number(summary.cited || 0)}</b><span>answers with sources</span></div><div><b>${Number(summary.unavailable || 0)}</b><span>excluded failures</span></div></div></div><div class="provider-health-grid">${providers}</div><div class="answer-context"><b>RUN CONTEXT</b><p>${escapeHtml(context)}<br>Completed ${escapeHtml(completedAt)}. Results are a dated observation, not a permanent ranking or availability guarantee.</p></div><div class="answer-dimension-nav">${dimensions.map((dimension) => `<a href="#answers-${escapeHtml(dimension)}">${escapeHtml(titleCase(dimension))}</a>`).join("")}</div><div class="answer-results">${dimensions.map((dimension) => `<section id="answers-${escapeHtml(dimension)}" class="answer-dimension"><div class="answer-dimension-head"><h3>${escapeHtml(titleCase(dimension))}</h3><span>${results.filter((item) => item.dimension === dimension && item.status === "mentioned").length}/${results.filter((item) => item.dimension === dimension && item.status !== "unavailable").length} mentions</span></div>${results.filter((item) => item.dimension === dimension).map(answerResultCard).join("")}</section>`).join("")}</div><p class="answer-audit-notice">${escapeHtml(audit.notice || "Automated public-web observations are evidence for review, not a guarantee of factual accuracy or current availability.")}</p>`;
  }

  async function pollAnswerAudit(initial) {
    renderAnswerAudit(initial);
    if (!["queued", "running", "not_started"].includes(initial?.status)) return;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        const response = await fetch(`/api/answer-audit/${encodeURIComponent(reportId)}`, { headers: { accept: "application/json" } });
        const audit = await response.json();
        renderAnswerAudit(audit);
        if (!["queued", "running", "not_started"].includes(audit?.status)) return;
      } catch { /* preserve the last trustworthy state and retry */ }
    }
    const target = document.querySelector("#answer-audit-content");
    target.insertAdjacentHTML("beforeend", `<p class="answer-audit-delay">This run is taking longer than expected. Refresh the report later to see the completed evidence.</p>`);
  }

  async function loadReport() {
    try {
      const response = await fetch(`/api/report/${encodeURIComponent(reportId)}`, { headers: { accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      const report = Array.isArray(payload) ? payload[0] : payload;
      if (!response.ok || !report?.short_id) throw new Error(payload.message || "The report link is invalid or expired.");

      const score = Math.max(0, Math.min(100, Number(report.overall_score || 0)));
      const [grade, summary, headline] = scoreBand(score);
      document.querySelector("#dealer-name").textContent = report.dealership_name || report.domain;
      document.querySelector("#dealer-domain").textContent = report.domain || "";
      document.querySelector("#dealer-city").textContent = report.city || "Market not supplied";
      document.querySelector("#scan-date").textContent = `Scanned ${new Date(report.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`;
      document.querySelector("#overall-score").textContent = score;
      document.querySelector("#score-dial").style.setProperty("--score", score);
      document.querySelector("#score-grade").textContent = grade;
      document.querySelector("#score-headline").textContent = headline;
      document.querySelector("#score-summary").textContent = summary;
      document.querySelector("#platform-scores").innerHTML = scoreCards(report.platform_scores, { chatgpt: "ChatGPT", aiOverviews: "Google AI Overviews", perplexity: "Perplexity", gemini: "Gemini", claude: "Claude", bingCopilot: "Bing Copilot" });
      document.querySelector("#category-scores").innerHTML = scoreCards(report.category_scores, { crawlerAccess: "Crawler access", structuredData: "Structured meaning", citability: "Citability", technical: "Technical health", authority: "Authority", brandMentions: "Brand connection" });
      renderReadiness(report.website_readiness);
      pollAnswerAudit(report.answer_audit || { status: "not_started" });
      const findings = Array.isArray(report.findings) ? report.findings : [];
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      findings.sort((a,b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));
      document.querySelector("#findings").innerHTML = findings.length ? findings.map(findingCard).join("") : `<article class="finding open"><div class="finding-head"><span class="severity low">clear</span><h3>No priority findings returned</h3></div></article>`;
      document.querySelector("#lead-form").elements.dealership.value = report.dealership_name || "";

      document.querySelectorAll(".finding-toggle").forEach((button) => button.addEventListener("click", () => {
        const card = button.closest(".finding");
        const open = card.classList.toggle("open");
        button.textContent = open ? "CLOSE −" : "OPEN +";
        button.setAttribute("aria-expanded", String(open));
      }));

      document.querySelector("#lead-form").addEventListener("submit", (event) => submitLead(event, report));
      loading.hidden = true;
      content.hidden = false;
    } catch (error) {
      console.error("Report render failed", error);
      loading.hidden = true;
      errorBox.hidden = false;
      document.querySelector("#report-error-message").textContent = String(error?.message || error || "This report could not be loaded.");
    }
  }

  async function submitLead(event, report) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.querySelector("#lead-status");
    const button = form.querySelector("button");
    status.textContent = "Sending…";
    button.disabled = true;
    try {
      const response = await fetch("/api/premium", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: form.elements.email.value, dealershipName: form.elements.dealership.value, phone: form.elements.phone.value || null, reportId: report.id, reportShortId: report.short_id, domain: report.domain, city: report.city, overallScore: report.overall_score }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "Could not send the request.");
      status.textContent = "Received. We’ll review the report and contact you.";
      form.reset();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Could not send the request.";
      button.disabled = false;
    }
  }

  document.querySelector("#share-report").addEventListener("click", async () => {
    const data = { title: document.title, text: "See this dealership’s AI visibility report.", url: location.href };
    try { if (navigator.share) await navigator.share(data); else { await navigator.clipboard.writeText(location.href); document.querySelector("#share-report").textContent = "LINK COPIED ✓"; } } catch { /* user cancelled */ }
  });

  loadReport();
})();
