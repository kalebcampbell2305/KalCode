import type { OpenIdProvider } from "./openid-connect";

const HANDOFF_SCRIPT =
  'history.replaceState(null,"",location.pathname);let attempted=false;addEventListener("DOMContentLoaded",()=>{if(attempted)return;attempted=true;const link=document.getElementById("open-kalcode");setTimeout(()=>{const fallback=document.getElementById("handoff-fallback");if(fallback instanceof HTMLElement)fallback.hidden=false;},1500);if(link instanceof HTMLAnchorElement)link.click();},{once:true});';
const HANDOFF_SCRIPT_SHA256 = "QJlZwCEUIs0xNO6mLw5czDA8+dQSbCsQHUUjU46Wlos=";

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
 * Returns a browser boundary for the native OIDC handoff. The page makes one best-effort automatic
 * custom-protocol launch after it is ready, then reveals an explicit fallback for browsers that
 * require a user gesture. It never treats browser navigation as proof that sign-in completed.
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
<script>${HANDOFF_SCRIPT}</script>
</head>
<body>
<main>
<h1>Return to KalCode</h1>
<p>Signing you in to KalCode&hellip;</p>
<p id="handoff-fallback" hidden>If KalCode does not open, select <a id="open-kalcode" href="${href}">Open KalCode</a> to finish this sign-in attempt.</p>
<noscript><p>JavaScript is unavailable. Select <a href="${href}">Open KalCode</a> to finish this sign-in attempt.</p></noscript>
<p>You can close this tab after KalCode opens.</p>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'sha256-${HANDOFF_SCRIPT_SHA256}'`,
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
