import { describe, expect, it } from "vitest";
import { EMAIL_FROM, EMAIL_REPLY_TO } from "../../src/lib/site";
import {
  actionUrl,
  renderAlreadyConfirmedEmail,
  renderConfirmEmail,
  renderLegacyConfirmEmail,
  renderRemovalEmail,
} from "../../worker/lib/emails";
import {
  captureMailer,
  isLoopbackHost,
  logMailer,
  mailerFromEnv,
  RESEND_ENDPOINT,
  redactEmail,
  resendMailer,
} from "../../worker/lib/mailer";
import { hashToken, isTokenFormat, newToken } from "../../worker/lib/tokens";

const MESSAGE = { to: "person@example.com", subject: "Subject", text: "Text body", html: "<p>Html body</p>" };
// Fake key for tests only; the real key exists only as a Worker secret.
const FAKE_KEY = "re_test_not_a_real_key";

interface Call {
  url: string;
  init: RequestInit;
}

function recordingFetch(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchImpl };
}

describe("resendMailer", () => {
  it("POSTs one JSON message to the Resend REST API with the approved sender", async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json({ id: "abc" }));
    const result = await resendMailer(FAKE_KEY, fetchImpl).send({ ...MESSAGE, idempotencyKey: "early-access-1" });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(RESEND_ENDPOINT);
    expect(RESEND_ENDPOINT).toBe("https://api.resend.com/emails");
    expect(call?.init.method).toBe("POST");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["idempotency-key"]).toBe("early-access-1");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(call?.init.body))).toEqual({
      from: EMAIL_FROM,
      to: ["person@example.com"],
      reply_to: EMAIL_REPLY_TO,
      subject: "Subject",
      text: "Text body",
      html: "<p>Html body</p>",
    });
    expect(EMAIL_FROM).toBe("KalCode <hello@kalcoded.com>");
    expect(EMAIL_REPLY_TO).toBe("kalcodebuilds@gmail.com");
  });

  it("reports a provider error by status only, never its text", async () => {
    const { fetchImpl } = recordingFetch(() =>
      Response.json({ message: "person@example.com is invalid; key re_live_secret" }, { status: 422 }),
    );
    const result = await resendMailer(FAKE_KEY, fetchImpl).send(MESSAGE);
    expect(result).toEqual({ ok: false, reason: "rejected", status: 422 });
  });

  it("treats a 500 as a failure", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("upstream down", { status: 500 }));
    expect(await resendMailer(FAKE_KEY, fetchImpl).send(MESSAGE)).toEqual({
      ok: false,
      reason: "rejected",
      status: 500,
    });
  });

  it("gives up after its timeout", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const started = Date.now();
    const result = await resendMailer(FAKE_KEY, hang, 50).send(MESSAGE);
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports network errors", async () => {
    const broken = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await resendMailer(FAKE_KEY, broken).send(MESSAGE)).toEqual({ ok: false, reason: "network" });
  });

  it("does not call out at all without a key", async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json({}));
    expect(await resendMailer(undefined, fetchImpl).send(MESSAGE)).toEqual({ ok: false, reason: "not_configured" });
    expect(await resendMailer("", fetchImpl).send(MESSAGE)).toEqual({ ok: false, reason: "not_configured" });
    expect(calls).toEqual([]);
  });
});

describe("captureMailer", () => {
  it("hands the message to a loopback mail sink", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
    const result = await captureMailer("http://127.0.0.1:8795/messages", fetchImpl).send(MESSAGE);
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("http://127.0.0.1:8795/messages");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ from: EMAIL_FROM, to: ["person@example.com"] });
  });

  it.each([undefined, "", "not a url", "https://127.0.0.1:8795/", "http://mail.example.com/", "http://10.0.0.1/"])(
    "refuses the non-loopback target %s",
    async (target) => {
      const { calls, fetchImpl } = recordingFetch(() => new Response(null));
      expect(await captureMailer(target, fetchImpl).send(MESSAGE)).toEqual({ ok: false, reason: "not_configured" });
      expect(calls).toEqual([]);
    },
  );

  it("reports a sink failure", async () => {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status: 500 }));
    expect(await captureMailer("http://localhost:1/", fetchImpl).send(MESSAGE)).toEqual({
      ok: false,
      reason: "rejected",
      status: 500,
    });
  });
});

describe("mailerFromEnv", () => {
  it("defaults to Resend and understands the three transports", () => {
    expect(mailerFromEnv({}, () => undefined).transport).toBe("resend");
    expect(mailerFromEnv({ EMAIL_TRANSPORT: "resend" }, () => undefined).transport).toBe("resend");
    expect(mailerFromEnv({ EMAIL_TRANSPORT: " Capture " }, () => undefined).transport).toBe("capture");
    expect(mailerFromEnv({ EMAIL_TRANSPORT: "log" }, () => undefined).transport).toBe("log");
    expect(mailerFromEnv({ EMAIL_TRANSPORT: "smtp" }, () => undefined).transport).toBe("invalid");
  });

  it("prints a redacted recipient with the log transport", async () => {
    const lines: string[] = [];
    await logMailer((line) => lines.push(line)).send(MESSAGE);
    expect(lines.join("\n")).toContain("p•••@example.com");
    expect(lines.join("\n")).not.toContain("person@");
    expect(redactEmail("x")).toBe("•••");
  });

  it("knows loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("kalcoded.com")).toBe(false);
  });
});

describe("link codes", () => {
  it("are 32 random bytes as 43 base64url characters, unique per call", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(isTokenFormat(code)).toBe(true);
  });

  it("are stored as lowercase hex SHA-256", async () => {
    await expect(hashToken("abc")).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("reject anything not shaped like an issued code", () => {
    for (const bad of [undefined, 42, "", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}/`]) {
      expect(isTokenFormat(bad)).toBe(false);
    }
  });
});

describe("email content", () => {
  const confirmUrl = actionUrl("https://kalcoded.com", "/early-access/confirm", "C".repeat(43));
  const removeUrl = actionUrl("https://kalcoded.com", "/early-access/remove", "R".repeat(43));

  it("builds links with the code as the token parameter", () => {
    expect(confirmUrl).toBe(`https://kalcoded.com/early-access/confirm?token=${"C".repeat(43)}`);
  });

  it.each([
    ["confirm", renderConfirmEmail({ confirmUrl, removeUrl, hours: 72 })],
    ["legacy", renderLegacyConfirmEmail({ confirmUrl, removeUrl, hours: 72 })],
    ["already confirmed", renderAlreadyConfirmedEmail({ removeUrl, hours: 72 })],
    ["removal", renderRemovalEmail({ removeUrl, hours: 72 })],
  ])("%s: plain text and HTML carry the same links, no images or tracking", (_name, email) => {
    expect(email.subject).toMatch(/KalCode early-access/);
    expect(email.text).toContain(removeUrl);
    expect(email.html).toContain(removeUrl);
    expect(email.text).toContain("72 hours");
    expect(email.html).not.toMatch(/<img|<script|<link|url\(|@import/i);
    const hrefs = [...email.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    for (const href of hrefs) expect(href).toMatch(/^https:\/\/kalcoded\.com(\/|$)/);
  });

  it("puts the confirm link only in the emails that confirm", () => {
    expect(renderConfirmEmail({ confirmUrl, removeUrl, hours: 72 }).text).toContain(confirmUrl);
    expect(renderAlreadyConfirmedEmail({ removeUrl, hours: 72 }).text).not.toContain("/early-access/confirm");
    expect(renderRemovalEmail({ removeUrl, hours: 72 }).text).not.toContain("/early-access/confirm");
  });

  it("escapes what it interpolates into HTML", () => {
    const html = renderRemovalEmail({ removeUrl: 'https://kalcoded.com/x?a="><script>', hours: 72 }).html;
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
