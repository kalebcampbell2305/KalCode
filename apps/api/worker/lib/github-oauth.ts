import { constantTimeEqual, sha256Base64Url } from "./crypto";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";
const PROVIDER_TIMEOUT_MS = 10_000;
const PKCE = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Za-z0-9_-]{1,256}$/;

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface GitHubIdentity {
  subject: string;
  email: string;
}

export class OAuthProviderError extends Error {
  constructor() {
    super("identity unavailable");
    this.name = "OAuthProviderError";
  }
}

export function isPkceChallenge(value: unknown): value is string {
  return typeof value === "string" && PKCE.test(value);
}

export function isPkceVerifier(value: unknown): value is string {
  return typeof value === "string" && PKCE.test(value);
}

export async function verifyPkce(verifier: string, expectedChallenge: string): Promise<boolean> {
  if (!isPkceVerifier(verifier) || !isPkceChallenge(expectedChallenge)) return false;
  return constantTimeEqual(await sha256Base64Url(verifier), expectedChallenge);
}

export function buildGitHubAuthorizeUrl(config: GitHubOAuthConfig, state: string, challenge: string): string {
  if (!isPkceChallenge(challenge)) throw new OAuthProviderError();
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: "user:email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function githubHeaders(accessToken?: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "KalCode",
    "x-github-api-version": "2022-11-28",
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function providerJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new OAuthProviderError();
  try {
    return await response.json();
  } catch {
    throw new OAuthProviderError();
  }
}

export async function exchangeGitHubCode(
  fetcher: typeof fetch,
  config: GitHubOAuthConfig,
  code: string,
  verifier: string,
): Promise<string> {
  if (!CODE.test(code) || !isPkceVerifier(verifier)) throw new OAuthProviderError();
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    // Workerd rejects `redirect: "error"` before issuing even a non-redirecting request.
    // Manual mode exposes a 3xx response without following it; the !response.ok check then rejects it.
    redirect: "manual",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: { ...githubHeaders(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
      code_verifier: verifier,
    }).toString(),
  });
  const value = await providerJson(response);
  const token = (value as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || token.length < 8 || token.length > 512) throw new OAuthProviderError();
  return token;
}

export async function fetchVerifiedGitHubIdentity(fetcher: typeof fetch, accessToken: string): Promise<GitHubIdentity> {
  // Workerd rejects `redirect: "error"` before issuing even a non-redirecting request.
  // Manual mode exposes a 3xx response without following it; the !response.ok check then rejects it.
  const headers = githubHeaders(accessToken);
  const user = (await providerJson(
    await fetcher(USER_URL, { headers, redirect: "manual", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }),
  )) as { id?: unknown };
  const emails = (await providerJson(
    await fetcher(EMAILS_URL, { headers, redirect: "manual", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }),
  )) as unknown;
  if (!Number.isSafeInteger(user.id) || (user.id as number) <= 0 || !Array.isArray(emails))
    throw new OAuthProviderError();
  const primary = emails.find(
    (entry): entry is { email: string; primary: true; verified: true } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { primary?: unknown }).primary === true &&
      (entry as { verified?: unknown }).verified === true &&
      typeof (entry as { email?: unknown }).email === "string",
  );
  const email = primary?.email.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new OAuthProviderError();
  return { subject: String(user.id), email };
}

/** The provider token is needed only to establish identity; revoke it before issuing a KalCode session. */
export async function revokeGitHubToken(
  fetcher: typeof fetch,
  config: GitHubOAuthConfig,
  accessToken: string,
): Promise<void> {
  const response = await fetcher(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
    method: "DELETE",
    // Workerd rejects `redirect: "error"` before issuing even a non-redirecting request.
    // Manual mode exposes a 3xx response without following it; the !response.ok check then rejects it.
    redirect: "manual",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      "content-type": "application/json",
      "user-agent": "KalCode",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (!response.ok) throw new OAuthProviderError();
}
