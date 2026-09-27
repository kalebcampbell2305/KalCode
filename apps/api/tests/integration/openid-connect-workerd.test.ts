/** Exercises OIDC response handling in pinned Workerd, including its native fetch implementation. */

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DevServer, startDevServer } from "../support/dev-server";
import { removeDatabase } from "../support/wrangler";

const PORT = Number(process.env.KALCODE_API_OIDC_TEST_PORT ?? 18435);
const INSPECTOR_PORT = PORT + 1000;

const discovery = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
  id_token_signing_alg_values_supported: ["RS256"],
  code_challenge_methods_supported: ["S256"],
};

let workerd: DevServer;
let upstream: Server;
let upstreamOrigin: string;
let persistTo: string;
let destinationRequests = 0;

beforeAll(async () => {
  upstream = createServer((request, response) => {
    if (request.url === "/canonical") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(discovery));
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/destination" });
      response.end();
      return;
    }
    if (request.url === "/destination") {
      destinationRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(discovery));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("test upstream did not bind TCP");
  upstreamOrigin = `http://127.0.0.1:${address.port}`;

  persistTo = mkdtempSync(join(tmpdir(), "kalcode-oidc-workerd-test-"));
  workerd = await startDevServer({
    script: "tests/support/openid-connect-workerd.ts",
    port: PORT,
    inspectorPort: INSPECTOR_PORT,
    persistTo,
    vars: {},
  });
});

afterAll(async () => {
  await workerd?.stop();
  await new Promise<void>((resolve, reject) => upstream?.close((error) => (error ? reject(error) : resolve())));
  await removeDatabase(persistTo);
});

async function probe(mode: string): Promise<{ stage: string }> {
  const url = new URL("/probe/exchange", workerd.origin);
  url.searchParams.set("mode", mode);
  url.searchParams.set("upstream", upstreamOrigin);
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json<{ stage: string }>();
}

describe("OpenID fetch behavior in Workerd", () => {
  it("supports the strict UTF-8 decoder used for provider JSON and JWT segments", async () => {
    await expect(fetch(`${workerd.origin}/probe/decoder`).then((response) => response.json())).resolves.toEqual({
      ok: true,
    });
  });

  it("reads a canonical 200 discovery response through native Workerd fetch", async () => {
    await expect(probe("canonical")).resolves.toEqual({ stage: "token_exchange" });
  });

  it("never follows a discovery, token or JWKS redirect", async () => {
    destinationRequests = 0;
    await expect(probe("discovery_redirect")).resolves.toEqual({ stage: "discovery" });
    await expect(probe("token_redirect")).resolves.toEqual({ stage: "token_exchange" });
    await expect(probe("jwks_redirect")).resolves.toEqual({ stage: "signature" });
    expect(destinationRequests).toBe(0);
  });
});
