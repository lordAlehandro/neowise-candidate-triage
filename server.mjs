import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const uiModule = await readFile(new URL("./ui.mjs", import.meta.url));

const STATIC_FILES = new Map([
  ["/", { body: html, type: "text/html; charset=utf-8" }],
  ["/ui.mjs", { body: uiModule, type: "text/javascript; charset=utf-8" }],
]);

const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);
const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function invalidInput(response) {
  return json(response, 400, { status: "invalid_input" });
}

function manualReview(response, reason) {
  if (reason) console.warn(`[triage] manual_review: ${reason}`);
  return json(response, 200, { status: "manual_review", topic: null, draft: null });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Returns the trimmed text, or null when the request body cannot be used. */
function readText(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof payload.text !== "string") return null;

  const text = payload.text.trim();
  return text === "" ? null : text;
}

/** Validates the model output. Returns null for any unusable answer. */
function readModelResult(raw) {
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  if (!ALLOWED_TOPICS.has(result.topic)) return null;
  if (typeof result.draft !== "string" || result.draft.trim() === "") return null;

  return { topic: result.topic, draft: result.draft.trim() };
}

async function askModel(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    return readModelResult(await classify(text, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response) {
  let text;
  try {
    text = readText(await readBody(request));
  } catch {
    return invalidInput(response);
  }
  if (text === null) return invalidInput(response);

  let result;
  try {
    result = await askModel(text);
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timeout" : "model_error";
    return manualReview(response, reason);
  }
  if (result === null) return manualReview(response, "invalid_model_output");

  return json(response, 200, { status: "ready", ...result });
}

export function createApp() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && STATIC_FILES.has(request.url)) {
      const file = STATIC_FILES.get(request.url);
      response.writeHead(200, { "Content-Type": file.type });
      response.end(file.body);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }

    try {
      await handleTriage(request, response);
    } catch (error) {
      console.error("[triage] unexpected error:", error);
      if (!response.headersSent) json(response, 500, { status: "server_error" });
      else response.end();
    }
  });
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Neowise triage: http://127.0.0.1:${port}`);
  });
}
