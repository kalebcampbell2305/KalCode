import { decodeBase64Url } from "./base64url";
import { constantTimeEqual } from "./crypto";
import { isPkceChallenge, isPkceVerifier, OAuthProviderError } from "./github-oauth";

const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_JSON_BYTES = 256 * 1024;
const MAX_ID_TOKEN_BYTES = 32 * 1024;
const AUTHORIZATION_CODE = /^[\x21-\x7e]{1,2048}$/;
const OPAQUE_VALUE = /^[A-Za-z0-9_-]{1,256}$/;
const FLOW_VALUE = /^[A-Za-z0-9_-]{43}$/;
const MICROSOFT_TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT = /^[\x21-\x7e]{1,255}$/;

export type OpenIdProvider = "google" | "microsoft";

export type OpenIdFailureStage =
  | "discovery"
  | "token_exchange"
  | "token_parse"
  | "signature"
  | "claims"
  | "claims_email"
  | "claims_email_verification_missing"
  | "claims_email_verification_type"
  | "claims_email_verification_denied"
  | "account_binding"
  | "identity_collision"
  | "session_creation";

/** Carries only an allowlisted stage. Provider responses and underlying errors are discarded. */
export class OpenIdExchangeError extends Error {
  readonly stage: OpenIdFailureStage;

  constructor(stage: OpenIdFailureStage) {
    super("identity unavailable");
    this.name = "OpenIdExchangeError";
    this.stage = stage;
  }
}

export interface OpenIdClientConfig {
  provider: OpenIdProvider;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface OpenIdIdentity {
  provider: OpenIdProvider;
  subject: string;
  email: string;
}

interface ProviderDescriptor {
  discoveryUrl: string;
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported: unknown;
  code_challenge_methods_supported: unknown;
}

interface ParsedToken {
  signingInput: Uint8Array;
  signature: Uint8Array;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

async function atStage<T>(stage: OpenIdFailureStage, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (
      stage === "claims" &&
      error instanceof OpenIdExchangeError &&
      (error.stage === "claims_email" ||
        error.stage === "claims_email_verification_missing" ||
        error.stage === "claims_email_verification_type" ||
        error.stage === "claims_email_verification_denied")
    ) {
      throw error;
    }
    throw new OpenIdExchangeError(stage);
  }
}

const PROVIDERS: Record<OpenIdProvider, ProviderDescriptor> = {
  google: {
    discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
    issuer: "https://accounts.google.com",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  },
  microsoft: {
    discoveryUrl: "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
    issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    jwksUrl: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
  },
};

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requestInit(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    // Workerd rejects `redirect: "error"` before issuing even a non-redirecting request.
    // Manual mode exposes a 3xx response without following it; readJson then rejects it.
    redirect: "manual",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new OAuthProviderError();
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_JSON_BYTES) throw new OAuthProviderError();
  if (!response.body) throw new OAuthProviderError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_PROVIDER_JSON_BYTES) throw new OAuthProviderError();
      chunks.push(item.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new OAuthProviderError();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new OAuthProviderError();
  }
}

function validateDiscovery(provider: OpenIdProvider, value: unknown): DiscoveryDocument {
  const document = object(value) as DiscoveryDocument | null;
  const expected = PROVIDERS[provider];
  if (
    !document ||
    document.issuer !== expected.issuer ||
    document.authorization_endpoint !== expected.authorizeUrl ||
    document.token_endpoint !== expected.tokenUrl ||
    document.jwks_uri !== expected.jwksUrl ||
    !Array.isArray(document.id_token_signing_alg_values_supported) ||
    !document.id_token_signing_alg_values_supported.includes("RS256") ||
    (provider === "google" &&
      (!Array.isArray(document.code_challenge_methods_supported) ||
        !document.code_challenge_methods_supported.includes("S256")))
  ) {
    throw new OAuthProviderError();
  }
  return document;
}

async function discovery(fetcher: typeof fetch, provider: OpenIdProvider): Promise<DiscoveryDocument> {
  const expected = PROVIDERS[provider];
  return validateDiscovery(provider, await readJson(await fetcher(expected.discoveryUrl, requestInit())));
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  const bytes = decodeBase64Url(segment);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_ID_TOKEN_BYTES) throw new OAuthProviderError();
  try {
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    const result = object(decoded);
    if (!result) throw new OAuthProviderError();
    return result;
  } catch {
    throw new OAuthProviderError();
  }
}

function parseIdToken(token: string): ParsedToken {
  if (token.length === 0 || token.length > MAX_ID_TOKEN_BYTES) throw new OAuthProviderError();
  const segments = token.split(".");
  if (segments.length !== 3) throw new OAuthProviderError();
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  if (!encodedHeader || !encodedClaims || !encodedSignature) throw new OAuthProviderError();
  const signature = decodeBase64Url(encodedSignature);
  if (!signature || signature.byteLength === 0) throw new OAuthProviderError();
  const header = decodeJsonSegment(encodedHeader);
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    !OPAQUE_VALUE.test(header.kid) ||
    "crit" in header ||
    "jku" in header ||
    "x5u" in header
  ) {
    throw new OAuthProviderError();
  }
  return {
    signingInput: new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    signature,
    header,
    claims: decodeJsonSegment(encodedClaims),
  };
}

function validJwk(value: unknown, kid: string): value is JsonWebKey & { issuer?: string } {
  const key = object(value);
  if (
    !key ||
    key.kid !== kid ||
    key.kty !== "RSA" ||
    (key.alg !== undefined && key.alg !== "RS256") ||
    key.use !== "sig"
  ) {
    return false;
  }
  if (typeof key.n !== "string" || !decodeBase64Url(key.n) || typeof key.e !== "string" || !decodeBase64Url(key.e)) {
    return false;
  }
  return key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes("verify"));
}

function microsoftIssuer(claims: Record<string, unknown>): { issuer: string; tenant: string } {
  const tenant = claims.tid;
  if (typeof tenant !== "string" || !MICROSOFT_TENANT.test(tenant)) throw new OAuthProviderError();
  const normalizedTenant = tenant.toLowerCase();
  const issuer = `https://login.microsoftonline.com/${normalizedTenant}/v2.0`;
  if (typeof claims.iss !== "string" || claims.iss.toLowerCase() !== issuer) throw new OAuthProviderError();
  return { issuer, tenant: normalizedTenant };
}

function validateKeyIssuer(
  provider: OpenIdProvider,
  key: JsonWebKey & { issuer?: string },
  claims: Record<string, unknown>,
) {
  if (provider !== "microsoft") return;
  const { issuer, tenant } = microsoftIssuer(claims);
  if (typeof key.issuer !== "string") throw new OAuthProviderError();
  const signingIssuer = key.issuer.replace("{tenantid}", tenant).toLowerCase();
  if (signingIssuer !== issuer) throw new OAuthProviderError();
}

async function verifySignature(
  fetcher: typeof fetch,
  provider: OpenIdProvider,
  jwksUrl: string,
  token: ParsedToken,
): Promise<void> {
  const value = object(await readJson(await fetcher(jwksUrl, requestInit())));
  if (!value || !Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 64) {
    throw new OAuthProviderError();
  }
  const kid = token.header.kid as string;
  const candidates = value.keys.filter((key) => validJwk(key, kid));
  if (candidates.length !== 1) throw new OAuthProviderError();
  const key = candidates[0] as JsonWebKey & { issuer?: string };
  validateKeyIssuer(provider, key, token.claims);
  try {
    const imported = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      imported,
      token.signature,
      token.signingInput,
    );
    if (!verified) throw new OAuthProviderError();
  } catch {
    throw new OAuthProviderError();
  }
}

function validAudience(claims: Record<string, unknown>, clientId: string): boolean {
  const audience = claims.aud;
  if (typeof audience === "string") {
    return audience === clientId && (claims.azp === undefined || claims.azp === clientId);
  }
  if (!Array.isArray(audience) || audience.length === 0 || !audience.every((item) => typeof item === "string")) {
    return false;
  }
  if (!audience.includes(clientId)) return false;
  return audience.length === 1 ? claims.azp === undefined || claims.azp === clientId : claims.azp === clientId;
}

function validTimes(claims: Record<string, unknown>, now: Date): boolean {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return false;
  const issuedAt = claims.iat as number;
  const expiresAt = claims.exp as number;
  if (issuedAt > nowSeconds + 60 || expiresAt <= nowSeconds || expiresAt <= issuedAt) return false;
  return claims.nbf === undefined || (Number.isSafeInteger(claims.nbf) && (claims.nbf as number) <= nowSeconds + 60);
}

function emailClaim(value: unknown): string {
  if (typeof value !== "string") throw new OAuthProviderError();
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new OAuthProviderError();
  return email;
}

function identityFromClaims(
  config: OpenIdClientConfig,
  claims: Record<string, unknown>,
  expectedNonce: string,
  now: Date,
): OpenIdIdentity {
  // Entra application IDs are UUIDs; the issued audience uses canonical lowercase.
  // Preserve case-sensitive audience matching for Google and non-UUID identifiers.
  const audienceClientId =
    config.provider === "microsoft" && MICROSOFT_TENANT.test(config.clientId)
      ? config.clientId.toLowerCase()
      : config.clientId;
  if (!validAudience(claims, audienceClientId) || !validTimes(claims, now)) throw new OAuthProviderError();
  if (typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, expectedNonce)) {
    throw new OAuthProviderError();
  }
  if (typeof claims.sub !== "string" || !SUBJECT.test(claims.sub)) throw new OAuthProviderError();

  if (config.provider === "google") {
    if (!(["https://accounts.google.com", "accounts.google.com"] as unknown[]).includes(claims.iss)) {
      throw new OAuthProviderError();
    }
    if (claims.email_verified !== true) throw new OAuthProviderError();
    return { provider: "google", subject: claims.sub, email: emailClaim(claims.email) };
  }

  if (claims.ver !== "2.0") throw new OAuthProviderError();
  const { tenant } = microsoftIssuer(claims);
  // Microsoft documents `email` and `preferred_username` as mutable and non-authoritative.
  // Only admit the email after the restricted `xms_edov` claim proves domain ownership; the
  // Entra app registration must request this optional ID-token claim. Never fall back to the
  // display-only `preferred_username`, because email magic-link login shares this account field.
  if (claims.xms_edov === undefined) throw new OpenIdExchangeError("claims_email_verification_missing");
  if (typeof claims.xms_edov !== "boolean") throw new OpenIdExchangeError("claims_email_verification_type");
  if (claims.xms_edov !== true) throw new OpenIdExchangeError("claims_email_verification_denied");
  let email: string;
  try {
    email = emailClaim(claims.email);
  } catch {
    throw new OpenIdExchangeError("claims_email");
  }
  return { provider: "microsoft", subject: `${tenant}:${claims.sub}`, email };
}

export function buildOpenIdAuthorizeUrl(
  config: OpenIdClientConfig,
  state: string,
  challenge: string,
  nonce: string,
): string {
  if (!FLOW_VALUE.test(state) || !isPkceChallenge(challenge) || !FLOW_VALUE.test(nonce)) {
    throw new OAuthProviderError();
  }
  const url = new URL(PROVIDERS[config.provider].authorizeUrl);
  const params: Record<string, string> = {
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  if (config.provider === "microsoft") params.response_mode = "query";
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export async function exchangeOpenIdIdentity(
  fetcher: typeof fetch,
  config: OpenIdClientConfig,
  code: string,
  verifier: string,
  expectedNonce: string,
  now: Date,
): Promise<OpenIdIdentity> {
  if (!AUTHORIZATION_CODE.test(code) || !isPkceVerifier(verifier) || !FLOW_VALUE.test(expectedNonce)) {
    throw new OpenIdExchangeError("token_exchange");
  }
  const metadata = await atStage("discovery", () => discovery(fetcher, config.provider));
  const tokenBody = await atStage("token_exchange", async () => {
    const tokenResponse = await fetcher(
      metadata.token_endpoint,
      requestInit({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.callbackUrl,
          grant_type: "authorization_code",
          code_verifier: verifier,
        }).toString(),
      }),
    );
    return object(await readJson(tokenResponse));
  });
  const rawIdToken = tokenBody?.id_token;
  if (typeof rawIdToken !== "string" || rawIdToken.length > MAX_ID_TOKEN_BYTES) {
    throw new OpenIdExchangeError("token_parse");
  }
  const token = await atStage("token_parse", () => parseIdToken(rawIdToken));
  await atStage("signature", () => verifySignature(fetcher, config.provider, metadata.jwks_uri, token));
  return atStage("claims", () => identityFromClaims(config, token.claims, expectedNonce, now));
}
