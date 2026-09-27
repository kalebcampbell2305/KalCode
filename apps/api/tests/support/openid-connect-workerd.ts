/** Test-only Workerd entry for OIDC fetch compatibility and redirect containment. */
import { exchangeOpenIdIdentity, OpenIdExchangeError } from "../../worker/lib/openid-connect";

const DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const NONCE = "n".repeat(43);

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function discoveryDocument() {
  return {
    issuer: "https://accounts.google.com",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: TOKEN_URL,
    jwks_uri: JWKS_URL,
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
  };
}

function segment(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unsignedTestToken(): string {
  return `${segment({ alg: "RS256", kid: "runtime-key" })}.${segment({})}.AQ`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/entitlement/keys") return json({ ready: true });
    if (url.pathname === "/probe/decoder") {
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(new Uint8Array([0x7b, 0x7d]));
      return json({ ok: decoded === "{}" });
    }
    if (url.pathname !== "/probe/exchange") return new Response("not found", { status: 404 });

    const upstream = url.searchParams.get("upstream");
    const mode = url.searchParams.get("mode");
    if (!upstream || !["canonical", "discovery_redirect", "token_redirect", "jwks_redirect"].includes(mode ?? "")) {
      return new Response("bad request", { status: 400 });
    }

    try {
      await exchangeOpenIdIdentity(
        async (input, init) => {
          const requested = String(input);
          if (requested === DISCOVERY_URL) {
            if (mode === "canonical") return fetch(`${upstream}/canonical`, init);
            if (mode === "discovery_redirect") return fetch(`${upstream}/redirect`, init);
            return json(discoveryDocument());
          }
          if (requested === TOKEN_URL) {
            if (mode === "token_redirect") return fetch(`${upstream}/redirect`, init);
            if (mode === "jwks_redirect") return json({ id_token: unsignedTestToken() });
            return json({ error: "synthetic_stop" }, 400);
          }
          if (requested === JWKS_URL && mode === "jwks_redirect") return fetch(`${upstream}/redirect`, init);
          throw new Error("unexpected OIDC request");
        },
        {
          provider: "google",
          clientId: "runtime-test.apps.googleusercontent.com",
          clientSecret: "synthetic-never-sent",
          callbackUrl: "https://api.kalcoded.com/v1/auth/google/callback",
        },
        "synthetic-code",
        VERIFIER,
        NONCE,
        new Date(),
      );
      return json({ stage: "unexpected_success" });
    } catch (error) {
      return json({ stage: error instanceof OpenIdExchangeError ? error.stage : "non_oidc_error" });
    }
  },
} satisfies ExportedHandler;
