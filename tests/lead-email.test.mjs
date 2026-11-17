import test from "node:test";
import assert from "node:assert/strict";

import protocolWorker from "../deployment/cloudflare/static-site-worker.mjs";
import productWorker from "../deployment/cloudflare/product-site-worker.mjs";

function bindings() {
  const databaseWrites = [];
  const emails = [];
  const tasks = [];
  return {
    databaseWrites,
    emails,
    tasks,
    env: {
      PILOT_DB: {
        prepare(sql) {
          return {
            bind(...values) {
              return {
                async run() {
                  databaseWrites.push({ sql, values });
                  return { success: true };
                },
              };
            },
          };
        },
      },
      EMAIL: {
        async send(message) {
          emails.push(message);
          return { messageId: `message-${emails.length}` };
        },
      },
    },
    context: {
      waitUntil(promise) {
        tasks.push(Promise.resolve(promise));
      },
    },
  };
}

function protocolBody(sourcePath = "/pilot/") {
  return {
    contact_name: "Ariel",
    work_email: "ariel@example.com",
    dealership_name: "Example Motors",
    dealership_website: "https://example.com",
    role: "Dealer principal",
    rooftop_count: "1",
    pilot_goal: "Show accurate inventory availability and pricing.",
    timeline: "now",
    source_path: sourcePath,
    consent: true,
  };
}

function auditBody() {
  return {
    contact_name: "Ariel",
    work_email: "ariel@example.com",
    dealership_name: "Example Motors",
    dealership_website: "https://example.com",
    role: "Dealer principal",
    rooftop_count: "1",
    market: "Miami, FL",
    audit_goal: "Check whether AI answers invent pricing or availability.",
    source_path: "/audit/",
    consent: true,
  };
}

async function post(worker, url, payload, state) {
  const response = await worker.fetch(new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Origin: new URL(url).origin },
    body: JSON.stringify(payload),
  }), state.env, state.context);
  await Promise.all(state.tasks);
  return response;
}

test("Protocol applications save before sending the internal alert and acknowledgment", async () => {
  const state = bindings();
  const response = await post(protocolWorker, "https://dealeragentprotocol.com/api/pilot-applications", protocolBody(), state);

  assert.equal(response.status, 201);
  assert.equal(state.databaseWrites.length, 1);
  assert.equal(state.emails.length, 2);
  assert.equal(state.emails[0].to, "ariel@dealergrowthhackers.com");
  assert.equal(state.emails[0].replyTo, "ariel@example.com");
  assert.deepEqual(state.emails[0].from, { email: "notifications@dealeragentprotocol.com", name: "Dealer Agent Protocol" });
  assert.equal(state.emails[1].to, "ariel@example.com");
  assert.equal(state.emails[1].replyTo, "ariel@dealergrowthhackers.com");
  assert.match(state.emails[1].text, /Example Motors/);
});

test("Gateway-originated applications use Gateway acknowledgment branding", async () => {
  const state = bindings();
  const response = await post(protocolWorker, "https://dealeragentprotocol.com/api/pilot-applications", protocolBody("/pilot/?source=dealeragentgateway.com"), state);

  assert.equal(response.status, 201);
  assert.deepEqual(state.emails[0].from, { email: "notifications@dealeragentgateway.com", name: "Dealer Agent Gateway" });
  assert.match(state.emails[0].subject, /^\[Dealer Agent Gateway\]/);
  assert.deepEqual(state.emails[1].from, { email: "notifications@dealeragentgateway.com", name: "Dealer Agent Gateway" });
  assert.match(state.emails[1].subject, /Dealer Agent Gateway/);
});

test("DealershipMCP audit requests send the alert and acknowledgment", async () => {
  const state = bindings();
  const response = await post(productWorker, "https://dealershipmcp.com/api/audit-applications", auditBody(), state);

  assert.equal(response.status, 201);
  assert.equal(state.databaseWrites.length, 1);
  assert.equal(state.emails.length, 2);
  assert.equal(state.emails[0].to, "ariel@dealergrowthhackers.com");
  assert.deepEqual(state.emails[0].from, { email: "notifications@dealershipmcp.com", name: "DealershipMCP" });
  assert.equal(state.emails[1].to, "ariel@example.com");
  assert.match(state.emails[1].text, /AI Answer Audit request/);
});

test("A delivery failure does not turn a saved application into a failed submission", async () => {
  const state = bindings();
  state.env.EMAIL.send = async () => { throw new Error("email unavailable"); };

  const response = await post(protocolWorker, "https://dealeragentprotocol.com/api/pilot-applications", protocolBody(), state);
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.accepted, true);
  assert.equal(state.databaseWrites.length, 1);
});

test("The honeypot accepts bots without saving or sending anything", async () => {
  const state = bindings();
  const payload = { ...protocolBody(), website_company: "spam.example" };

  const response = await post(protocolWorker, "https://dealeragentprotocol.com/api/pilot-applications", payload, state);

  assert.equal(response.status, 201);
  assert.equal(state.databaseWrites.length, 0);
  assert.equal(state.emails.length, 0);
});
