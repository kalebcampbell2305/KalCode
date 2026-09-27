import type { OpenIdProvider } from "./openid-connect";

const HISTORY_REPLACE_SCRIPT = 'history.replaceState(null, "", location.pathname);';
const HISTORY_REPLACE_SCRIPT_SHA256 = "ixzo+owSEfJWq9z0HJaxCJAlk3mRYZRq9JaxhZ3hBmA=";

type NativeAuthResult =
  | { state: string; code: string }
  | { state: string; error: "sign_in_canceled" | "sign_in_failed" };

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * Returns a script-free-except-for-history-cleanup browser boundary for the native OIDC handoff.
 * The short-lived authorization values remain only in the explicit custom-protocol link. They are
 * never persisted here, and no automatic navigation can bypass the browser's user-gesture policy.
 */
export function nativeAuthHandoff(provider: OpenIdProvider, result: NativeAuthResult): Response {
  const destination = new URL(`kalcode://auth/${provider}`);
  if ("error" in result) destination.searchParams.set("error", result.error);
  else destination.searchParams.set("code", result.code);
  destination.searchParams.set("state", result.state);
  const href = escapeHtmlAttribute(destination.toString());
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Return to KalCode</title>
<script>${HISTORY_REPLACE_SCRIPT}</script>
</head>
<body>
<main>
<h1>Return to KalCode</h1>
<p>Open KalCode to finish this sign-in attempt.</p>
<p><a href="${href}">Open KalCode</a></p>
<p>You can close this tab after KalCode opens.</p>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'sha256-${HISTORY_REPLACE_SCRIPT_SHA256}'`,
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}
