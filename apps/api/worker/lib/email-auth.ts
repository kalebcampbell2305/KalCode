import type { AccountMailer } from "./account-mailer";
import type { AccountStore, EmailAttempt } from "./account-store";
import { SESSION_COOKIE, sessionToken } from "./auth";
import { readJsonBody } from "./body";
import { hmacSha256Base64Url, randomBase64Url, sha256Base64Url } from "./crypto";
import { isPkceChallenge, isPkceVerifier, verifyPkce } from "./github-oauth";
import { apiError, json } from "./http";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const WEBSITE_ORIGIN = "https://kalcoded.com";
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,189}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const GENERIC = "This sign-in link is invalid or expired. Start again.";

export interface EmailAuthService {
  start(request: Request): Promise<Response>;
  startDelete(request: Request, accountId: string, email: string): Promise<Response>;
  verify(request: Request): Promise<Response>;
  poll(request: Request): Promise<Response>;
  refresh(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
}

interface Options {
  store: AccountStore;
  mailer: AccountMailer;
  rateLimitKey: string;
  now: () => Date;
}

function writeAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === WEBSITE_ORIGIN;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  const hasControlCharacter = [...email].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  return email.length <= 254 && EMAIL.test(email) && !hasControlCharacter ? email : null;
}

async function objectBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readJsonBody(request);
  return body.ok && typeof body.value === "object" && body.value !== null && !Array.isArray(body.value)
    ? (body.value as Record<string, unknown>)
    : null;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function emailAuthService({ store, mailer, rateLimitKey, now }: Options): EmailAuthService {
  async function mailIdentity(ip: string, email: string) {
    return {
      networkHash: await hmacSha256Base64Url(rateLimitKey, `account-mail:network:${ip}`),
      recipientHash: await hmacSha256Base64Url(rateLimitKey, `account-mail:recipient:${email}`),
    };
  }

  async function allowed(
    _request: Request,
    action: "email_start" | "email_verify" | "email_poll" | "session_refresh" | "account_delete",
    bucket: string,
    limit: number,
  ) {
    const at = now();
    return store.allowRateLimit({
      bucketHash: await hmacSha256Base64Url(rateLimitKey, bucket),
      action,
      now: at.toISOString(),
      windowStart: new Date(at.getTime() - TEN_MINUTES_MS).toISOString(),
      retentionStart: new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      limit,
    });
  }

  async function consume(attempt: EmailAttempt): Promise<{ token: string; expiresAt: string } | null> {
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + SESSION_MS);
    const token = `kcs_${randomBase64Url()}`;
    const session = await store.consumeEmailAttempt({
      verifyHash: attempt.verifyHash,
      consumeNonce: randomBase64Url(),
      tokenHash: await sha256Base64Url(token),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return session ? { token, expiresAt: session.expiresAt } : null;
  }

  return {
    async start(request) {
      if (!writeAllowed(request)) return apiError(403, "forbidden", "This request origin is not allowed.");
      const body = await objectBody(request);
      if (!body) return apiError(400, "invalid_request", "Enter a valid email address.");
      const email = normalizeEmail(body.email);
      const clientKind = body.client;
      const challenge = body.codeChallenge;
      if (
        !email ||
        (clientKind !== "desktop" && clientKind !== "website") ||
        (clientKind === "desktop" ? !isPkceChallenge(challenge) : challenge !== undefined) ||
        Object.keys(body).some((key) => !["email", "client", "codeChallenge"].includes(key))
      ) {
        return apiError(400, "invalid_request", "Enter a valid email address.");
      }
      const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
      if (
        !(await allowed(request, "email_start", `ip:${ip}`, 10)) ||
        !(await allowed(request, "email_start", `email:${email}`, 5))
      ) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const verifyToken = randomBase64Url();
      const pollToken = randomBase64Url();
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + TEN_MINUTES_MS);
      const verifyHash = await sha256Base64Url(verifyToken);
      await store.createEmailAttempt({
        verifyHash,
        pollHash: await sha256Base64Url(pollToken),
        email,
        clientKind,
        purpose: "signin",
        accountId: null,
        codeChallenge: clientKind === "desktop" ? (challenge as string) : null,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      if (!(await mailer.sendSignIn(email, verifyToken, await mailIdentity(ip, email)))) {
        await store.deleteEmailAttempt(verifyHash);
        return apiError(503, "service_unavailable", "Email sign-in is temporarily unavailable.");
      }
      return json(
        {
          ok: true,
          status: "email_sent",
          expiresAt: expiresAt.toISOString(),
          ...(clientKind === "desktop" ? { pollToken } : {}),
        },
        200,
      );
    },

    async startDelete(request, accountId, email) {
      if (request.headers.get("origin") !== WEBSITE_ORIGIN) {
        return apiError(403, "forbidden", "Open account deletion from kalcoded.com.");
      }
      const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
      if (
        !(await allowed(request, "account_delete", `ip:${ip}`, 5)) ||
        !(await allowed(request, "account_delete", `account:${accountId}`, 3))
      ) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const verifyToken = randomBase64Url();
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + TEN_MINUTES_MS);
      const verifyHash = await sha256Base64Url(verifyToken);
      await store.createEmailAttempt({
        verifyHash,
        pollHash: await sha256Base64Url(randomBase64Url()),
        email,
        clientKind: "website",
        purpose: "delete",
        accountId,
        codeChallenge: null,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      if (!(await mailer.sendDelete(email, verifyToken, await mailIdentity(ip, email)))) {
        await store.deleteEmailAttempt(verifyHash);
        return apiError(503, "service_unavailable", "Account deletion email is temporarily unavailable.");
      }
      return json({ ok: true, status: "email_sent", expiresAt: expiresAt.toISOString() }, 200);
    },

    async verify(request) {
      if (!writeAllowed(request)) return apiError(403, "forbidden", "This request origin is not allowed.");
      const body = await objectBody(request);
      const token = body?.token;
      if (!body || Object.keys(body).length !== 1 || typeof token !== "string" || !TOKEN.test(token)) {
        return apiError(400, "sign_in_failed", GENERIC);
      }
      const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
      if (!(await allowed(request, "email_verify", `ip:${ip}`, 30))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const verifyHash = await sha256Base64Url(token);
      const attempt = await store.emailAttempt("verify", verifyHash);
      const at = now().toISOString();
      if (attempt?.purpose !== "signin" || attempt.expiresAt <= at || attempt.consumedAt) {
        if (attempt?.purpose !== "delete" || attempt.expiresAt <= at || attempt.consumedAt) {
          return apiError(400, "sign_in_failed", GENERIC);
        }
        const current = sessionToken(request);
        if (!current || !attempt.accountId) return apiError(401, "unauthenticated", "Sign in to continue.");
        const session = await store.sessionInfo(await sha256Base64Url(current), at);
        if (!session || session.accountId !== attempt.accountId || session.clientKind !== "website") {
          return apiError(401, "unauthenticated", "Sign in to continue.");
        }
        if (
          !(await store.softDeleteAccount({
            verifyHash,
            accountId: attempt.accountId,
            consumeNonce: randomBase64Url(),
            now: at,
          }))
        ) {
          return apiError(409, "account_delete_blocked", "Resolve active billing before deleting this account.");
        }
        return json({ ok: true, status: "deleted" }, 200, { "set-cookie": clearSessionCookie() });
      }
      const verified = await store.markEmailVerified({
        verifyHash,
        accountId: `acct_${randomBase64Url(24)}`,
        now: at,
      });
      if (!verified) return apiError(400, "sign_in_failed", GENERIC);
      if (verified.clientKind === "desktop") return json({ ok: true, status: "verified" }, 200);
      const session = await consume(verified);
      if (!session) return apiError(400, "sign_in_failed", GENERIC);
      return json({ ok: true, status: "signed_in" }, 200, {
        "set-cookie": sessionCookie(session.token, SESSION_MS / 1000),
      });
    },

    async poll(request) {
      if (request.headers.has("origin")) return apiError(403, "forbidden", "Browser requests are not accepted.");
      const body = await objectBody(request);
      const pollToken = body?.pollToken;
      const verifier = body?.codeVerifier;
      if (
        !body ||
        Object.keys(body).length !== 2 ||
        typeof pollToken !== "string" ||
        !TOKEN.test(pollToken) ||
        !isPkceVerifier(verifier)
      ) {
        return apiError(400, "sign_in_failed", GENERIC);
      }
      const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
      if (!(await allowed(request, "email_poll", `ip:${ip}`, 60))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const pollHash = await sha256Base64Url(pollToken);
      const attempt = await store.emailAttempt("poll", pollHash);
      const at = now().toISOString();
      if (
        attempt?.clientKind !== "desktop" ||
        attempt.purpose !== "signin" ||
        !attempt.codeChallenge ||
        attempt.expiresAt <= at ||
        attempt.consumedAt ||
        !(await verifyPkce(verifier, attempt.codeChallenge))
      ) {
        return apiError(400, "sign_in_failed", GENERIC);
      }
      if (!(await allowed(request, "email_poll", `attempt:${pollHash}`, 30))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      if (!attempt.verifiedAt || !attempt.accountId) return json({ ok: true, status: "pending" }, 202);
      const session = await consume(attempt);
      return session
        ? json({ ok: true, status: "signed_in", token: session.token, expiresAt: session.expiresAt }, 200)
        : apiError(400, "sign_in_failed", GENERIC);
    },

    async refresh(request) {
      if (!writeAllowed(request)) return apiError(403, "forbidden", "This request origin is not allowed.");
      const current = sessionToken(request);
      if (!current) return apiError(401, "unauthenticated", "Sign in to continue.");
      const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
      if (!(await allowed(request, "session_refresh", `ip:${ip}`, 30))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const createdAt = now();
      const oldTokenHash = await sha256Base64Url(current);
      if (!(await store.sessionInfo(oldTokenHash, createdAt.toISOString()))) {
        return apiError(401, "unauthenticated", "Sign in to continue.");
      }
      if (!(await allowed(request, "session_refresh", `session:${oldTokenHash}`, 10))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const expiresAt = new Date(createdAt.getTime() + SESSION_MS);
      const token = `kcs_${randomBase64Url()}`;
      const rotated = await store.rotateSession({
        oldTokenHash,
        newTokenHash: await sha256Base64Url(token),
        now: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      if (!rotated) return apiError(401, "unauthenticated", "Sign in to continue.");
      return rotated.clientKind === "website"
        ? json({ ok: true, expiresAt: rotated.expiresAt }, 200, {
            "set-cookie": sessionCookie(token, SESSION_MS / 1000),
          })
        : json({ ok: true, token, expiresAt: rotated.expiresAt }, 200);
    },

    async logout(request) {
      if (!writeAllowed(request)) return apiError(403, "forbidden", "This request origin is not allowed.");
      const token = sessionToken(request);
      if (token) await store.revokeSession(await sha256Base64Url(token), now().toISOString());
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": clearSessionCookie(), "cache-control": "no-store" },
      });
    },
  };
}
