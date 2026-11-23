import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createApp } from "./server.mjs";
import { manualViewModel, toViewModel } from "./ui.mjs";

let server;
let baseUrl;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function triage(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, payload: await response.json() };
}

describe("Static assets", () => {
  it("serves the page and the ES module it imports", async () => {
    const page = await fetch(baseUrl + "/");
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /import .* from "\.\/ui\.mjs"/);

    const module = await fetch(baseUrl + "/ui.mjs");
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type"), /javascript/);
    assert.match(await module.text(), /export function toViewModel/);
  });

  it("has a style rule for every view kind", async () => {
    const css = await readFile(new URL("./index.html", import.meta.url), "utf8");
    for (const kind of ["ready", "manual_review", "loading"]) {
      assert.match(css, new RegExp(`\\.status-${kind}\\b`), `missing style for ${kind}`);
    }
  });
});

describe("POST /api/triage — Validation", () => {
  const badBodies = [
    ["broken JSON", "{oops"],
    ["missing text", "{}"],
    ["empty text", JSON.stringify({ text: "" })],
    ["whitespace-only text", JSON.stringify({ text: "  \n\t " })],
    ["numeric text", JSON.stringify({ text: 42 })],
    ["null text", JSON.stringify({ text: null })],
    ["JSON array", "[]"],
  ];

  for (const [name, body] of badBodies) {
    it(`returns 400 invalid_input for ${name}`, async () => {
      const { status, payload } = await triage(body);
      assert.equal(status, 400);
      assert.deepEqual(payload, { status: "invalid_input" });
    });
  }
});

describe("POST /api/triage — Ready replies", () => {
  it("returns a topic and a non-empty draft for a normal request", async () => {
    const { status, payload } = await triage(
      JSON.stringify({ text: "Здравствуйте, когда будет доставка?" }),
    );
    assert.equal(status, 200);
    assert.equal(payload.status, "ready");
    assert.equal(payload.topic, "delivery");
    assert.ok(payload.draft.trim().length > 0);
  });

  it("recognises pricing and other topics", async () => {
    const pricing = await triage(JSON.stringify({ text: "Подскажите стоимость" }));
    assert.equal(pricing.payload.topic, "pricing");

    const other = await triage(JSON.stringify({ text: "Есть вопрос по аккаунту" }));
    assert.equal(other.payload.topic, "other");
  });
});

describe("POST /api/triage — AI failure falls back to manual review", () => {
  const failures = ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"];

  for (const label of failures) {
    it(`${label} returns manual_review with no topic and no draft`, async () => {
      const { status, payload } = await triage(
        JSON.stringify({ text: `Вопрос ${label} по доставке` }),
      );
      assert.equal(status, 200);
      assert.deepEqual(payload, { status: "manual_review", topic: null, draft: null });
    });
  }

  it("gives up on the model within the 300 ms limit", async () => {
    const started = performance.now();
    await triage(JSON.stringify({ text: "[timeout] длинная доставка" }));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 900, `model call took ${Math.round(elapsed)} ms, expected < 900 ms`);
  });
});

describe("UI view model", () => {
  it("drops a previously rendered draft when the review is manual", () => {
    const previous = toViewModel({
      status: "ready",
      topic: "delivery",
      draft: "Старый черновик",
    });
    assert.equal(previous.draft, "Старый черновик");

    const manual = manualViewModel();
    assert.equal(manual.kind, "manual_review");
    assert.equal(manual.topic, null);
    assert.equal(manual.draft, null);
    assert.match(manual.message, /вручную/);
  });

  it("shows a ready draft under a human-readable topic", () => {
    const view = toViewModel({ status: "ready", topic: "pricing", draft: "Ответ" });
    assert.equal(view.kind, "ready");
    assert.equal(view.topic, "Цена и оплата");
    assert.equal(view.draft, "Ответ");
  });

  it("does not trust malformed API replies", () => {
    for (const reply of [null, { status: "ready" }, { status: "ready", topic: "refund", draft: "x" }]) {
      assert.equal(toViewModel(reply).kind, "manual_review");
    }
  });
});
