(() => {
  const form = document.querySelector("#audit-form");
  if (!form) return;

  const status = document.querySelector("#form-status");
  const submit = form.querySelector("button[type=submit]");
  const params = new URLSearchParams(location.search);
  form.elements.source_path.value = `${location.pathname}${params.get("ref") ? `?ref=${params.get("ref").slice(0, 80)}` : ""}`;

  const normalizeUrl = (value) => {
    const clean = value.trim();
    if (!clean) return "";
    return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
  };

  const validUrl = (value, optional = false) => {
    if (optional && !value) return true;
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname.includes(".");
    } catch {
      return false;
    }
  };

  const fail = (field, message) => {
    field.classList.add("field-error");
    field.setAttribute("aria-invalid", "true");
    status.className = "form-status error";
    status.textContent = message;
    field.focus();
  };

  const clearErrors = () => {
    form.querySelectorAll(".field-error").forEach((field) => {
      field.classList.remove("field-error");
      field.removeAttribute("aria-invalid");
    });
    status.className = "form-status";
    status.textContent = "";
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors();

    const fields = form.elements;
    const website = normalizeUrl(fields.dealership_website.value);
    const reportUrl = normalizeUrl(fields.visibility_report_url.value);
    fields.dealership_website.value = website;
    fields.visibility_report_url.value = reportUrl;

    if (!fields.contact_name.value.trim()) return fail(fields.contact_name, "Enter your name.");
    if (!/^\S+@\S+\.\S+$/.test(fields.work_email.value.trim())) return fail(fields.work_email, "Enter a valid work email.");
    if (!fields.dealership_name.value.trim()) return fail(fields.dealership_name, "Enter the dealership or group name.");
    if (!fields.role.value.trim()) return fail(fields.role, "Enter your role.");
    if (!validUrl(website)) return fail(fields.dealership_website, "Enter a valid dealership website.");
    if (!fields.market.value.trim()) return fail(fields.market, "Enter the dealership's primary market.");
    if (!fields.rooftop_count.value) return fail(fields.rooftop_count, "Select the rooftop count.");
    if (!fields.audit_trigger.value) return fail(fields.audit_trigger, "Select what triggered this audit request.");
    if (!validUrl(reportUrl, true)) return fail(fields.visibility_report_url, "Enter a valid report link or leave it blank.");
    if (fields.audit_goal.value.trim().length < 20) return fail(fields.audit_goal, "Tell us in at least 20 characters what the audit needs to resolve.");
    if (!fields.consent.checked) return fail(fields.consent, "Consent is required before we can review the request.");

    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    status.textContent = "Submitting your audit request…";

    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { "accept": "application/json" },
        body: new FormData(form),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "The request could not be saved.");
      form.reset();
      status.className = "form-status success";
      status.textContent = "Request received. Dealer Growth Hackers will review the scope and contact you at the work email provided.";
      status.focus?.();
    } catch (error) {
      status.className = "form-status error";
      status.textContent = `${error instanceof Error ? error.message : "The request could not be saved."} Email ariel@dealergrowthhackers.com if the issue continues.`;
    } finally {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
    }
  });
})();
