// Local mail sink for the Playwright suite. The Worker runs with EMAIL_TRANSPORT=capture and
// EMAIL_CAPTURE_URL=http://127.0.0.1:<port>/messages, so every email it would send lands here
// instead of reaching Resend or a real inbox. Tests read and control it over HTTP:
//
//   POST /messages          (the Worker) store one message; answers 500 while failing
//   GET  /messages?to=addr  messages sent to addr, oldest first
//   POST /fail {"count":n}  fail the next n sends with HTTP 500 (0 clears)
//   POST /fail {"count":n,"to":addr}  the same, for sends to addr only: tests running side by
//                           side never take (or are spared) each other's simulated failure
//   GET  /health            readiness probe for Playwright's webServer
//
// Listens on 127.0.0.1 only. Usage: node tests/e2e/mail-sink.mjs <port>
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.KALCODE_E2E_MAIL_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: node tests/e2e/mail-sink.mjs <port>");
  process.exit(64);
}

const messages = [];
let failNext = 0;
/** Simulated failures left per recipient (lowercased). */
const failFor = new Map();

function takeFailure(message) {
  for (const address of message.to ?? []) {
    const key = String(address).toLowerCase();
    const left = failFor.get(key) ?? 0;
    if (left > 0) {
      if (left === 1) failFor.delete(key);
      else failFor.set(key, left - 1);
      return true;
    }
  }
  if (failNext === 0) return false;
  failNext -= 1;
  return true;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true });
    if (request.method === "POST" && url.pathname === "/messages") {
      const message = JSON.parse(await readBody(request));
      if (takeFailure(message)) return send(response, 500, { message: "simulated provider failure" });
      messages.push({ ...message, receivedAt: new Date().toISOString() });
      return send(response, 200, { id: `sink-${messages.length}` });
    }
    if (request.method === "GET" && url.pathname === "/messages") {
      const to = url.searchParams.get("to")?.toLowerCase();
      return send(
        response,
        200,
        messages.filter((message) => !to || message.to?.some((address) => address.toLowerCase() === to)),
      );
    }
    if (request.method === "POST" && url.pathname === "/fail") {
      const { count, to } = JSON.parse((await readBody(request)) || "{}");
      const n = Number.isInteger(count) && count > 0 ? count : 0;
      if (typeof to !== "string") {
        failNext = n;
        return send(response, 200, { failNext });
      }
      if (n > 0) failFor.set(to.toLowerCase(), n);
      else failFor.delete(to.toLowerCase());
      return send(response, 200, { failNext: n, to });
    }
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    return send(response, 400, { error: error instanceof Error ? error.message : "bad request" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mail sink listening on http://127.0.0.1:${port}`);
});
