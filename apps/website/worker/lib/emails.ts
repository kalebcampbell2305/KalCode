/**
 * The early-access emails: subject, plain text and minimal branded HTML.
 *
 * Deliberately import-free, so the Worker and the operator script
 * (tooling/admin/request-legacy-confirmation.mjs, run by Node) render identical messages.
 * The HTML has no images, no remote resources and no tracking: every link points straight at
 * kalcoded.com.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface LinkSet {
  /** Absolute link to the confirmation page (absent for an address that is already confirmed). */
  confirmUrl?: string;
  /** Absolute link to the removal page. */
  removeUrl: string;
  /** How long the links work, in hours. */
  hours: number;
}

/** `origin` + page path + the link code as the `token` query parameter. */
export function actionUrl(origin: string, path: string, token: string): string {
  const url = new URL(path, origin);
  url.searchParams.set("token", token);
  return url.href;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const INK = "#0b1220";
const MUTED = "#4a5568";
const ACCENT = "#1d5be0";
const NIGHT = "#05080f";

interface Block {
  kind: "p" | "button" | "small";
  /** Button text is escaped; paragraph text is trusted markup written in this file (URLs escaped). */
  text: string;
  href?: string;
}

function layout(preheader: string, heading: string, blocks: Block[]): string {
  const body = blocks
    .map((block) => {
      if (block.kind === "button" && block.href) {
        const href = escapeHtml(block.href);
        return (
          `<p style="margin:28px 0"><a href="${href}" style="display:inline-block;background:${ACCENT};color:#ffffff;` +
          `text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">${escapeHtml(block.text)}</a></p>` +
          `<p style="margin:0 0 20px;color:${MUTED};font-size:13px;line-height:1.5;word-break:break-all">` +
          `Or paste this link into your browser:<br><a href="${href}" style="color:${ACCENT}">${href}</a></p>`
        );
      }
      if (block.kind === "small") {
        return `<p style="margin:0 0 14px;color:${MUTED};font-size:13px;line-height:1.55">${block.text}</p>`;
      }
      return `<p style="margin:0 0 16px;line-height:1.6">${block.text}</p>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fb;color:${INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px">
<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="background:${NIGHT};color:#ffffff;border-radius:12px 12px 0 0;padding:18px 24px;font-weight:700;letter-spacing:0.08em">KALCODE</div>
<div style="background:#ffffff;border-radius:0 0 12px 12px;padding:28px 24px">
<h1 style="margin:0 0 18px;font-size:22px;line-height:1.3">${escapeHtml(heading)}</h1>
${body}
</div>
<p style="margin:16px 8px 0;color:${MUTED};font-size:12px;line-height:1.5">KalCode · <a href="https://kalcoded.com" style="color:${MUTED}">kalcoded.com</a> · You can reply to this email with any question.</p>
</div>
</body>
</html>`;
}

function footerText(): string {
  return "KalCode · https://kalcoded.com\nYou can reply to this email with any question.";
}

/** Sent when someone joins with an address that is not confirmed yet. */
export function renderConfirmEmail(links: LinkSet & { confirmUrl: string }): RenderedEmail {
  const subject = "Confirm your KalCode early-access email";
  const text = [
    "Hi,",
    "",
    "Someone, hopefully you, asked to join the KalCode early-access list with this address.",
    "",
    "Confirm your email:",
    links.confirmUrl,
    "",
    `The link works once and expires in ${links.hours} hours. If you didn't ask to join, ignore this email: unconfirmed addresses are deleted when the link expires.`,
    "",
    "Changed your mind? Remove this address from the list:",
    links.removeUrl,
    "",
    footerText(),
  ].join("\n");
  const html = layout("Confirm your email to join the KalCode early-access list.", "Confirm your email", [
    { kind: "p", text: "Someone, hopefully you, asked to join the KalCode early-access list with this address." },
    { kind: "button", text: "Confirm my email", href: links.confirmUrl },
    {
      kind: "small",
      text: `The link works once and expires in ${links.hours} hours. If you didn't ask to join, ignore this email: unconfirmed addresses are deleted when the link expires.`,
    },
    {
      kind: "small",
      text: `Changed your mind? <a href="${escapeHtml(links.removeUrl)}" style="color:${ACCENT}">Remove this address from the list</a>.`,
    },
  ]);
  return { subject, text, html };
}

/**
 * Sent when someone joins with an address that is already confirmed. The web response is the
 * same as for a new address, so the form never reveals who is on the list; this email tells
 * the owner instead, and offers removal.
 */
export function renderAlreadyConfirmedEmail(links: LinkSet): RenderedEmail {
  const subject = "You're already on the KalCode early-access list";
  const text = [
    "Hi,",
    "",
    "Someone, hopefully you, asked to join the KalCode early-access list with this address. It's already confirmed, so there's nothing to do. We'll email you when there is a build to try.",
    "",
    "Want to leave the list? Remove this address:",
    links.removeUrl,
    "",
    `The removal link works once and expires in ${links.hours} hours.`,
    "",
    footerText(),
  ].join("\n");
  const html = layout("Your address is already confirmed. Nothing to do.", "You're already on the list", [
    {
      kind: "p",
      text: "Someone, hopefully you, asked to join the KalCode early-access list with this address. It's already confirmed, so there's nothing to do. We'll email you when there is a build to try.",
    },
    { kind: "small", text: "Want to leave the list? Use the button below." },
    { kind: "button", text: "Remove my email", href: links.removeUrl },
    { kind: "small", text: `The removal link works once and expires in ${links.hours} hours.` },
  ]);
  return { subject, text, html };
}

/** Sent when someone asks, on the privacy page, to remove an address that is on the list. */
export function renderRemovalEmail(links: LinkSet): RenderedEmail {
  const subject = "Confirm removal from the KalCode early-access list";
  const text = [
    "Hi,",
    "",
    "Someone, hopefully you, asked to remove this address from the KalCode early-access list.",
    "",
    "Confirm the removal:",
    links.removeUrl,
    "",
    `The link works once and expires in ${links.hours} hours. If you didn't ask for this, ignore this email and nothing changes.`,
    "",
    footerText(),
  ].join("\n");
  const html = layout("Confirm that you want to leave the KalCode early-access list.", "Confirm removal", [
    { kind: "p", text: "Someone, hopefully you, asked to remove this address from the KalCode early-access list." },
    { kind: "button", text: "Remove my email", href: links.removeUrl },
    {
      kind: "small",
      text: `The link works once and expires in ${links.hours} hours. If you didn't ask for this, ignore this email and nothing changes.`,
    },
  ]);
  return { subject, text, html };
}

/**
 * The one-time request an operator sends to addresses that joined before confirmation existed
 * (tooling/admin/request-legacy-confirmation.mjs). Never sent automatically.
 */
export function renderLegacyConfirmEmail(links: LinkSet & { confirmUrl: string }): RenderedEmail {
  const subject = "Confirm your KalCode early-access email";
  const text = [
    "Hi,",
    "",
    "This address joined the KalCode early-access list before we started confirming addresses. Please confirm that you want to stay on the list:",
    links.confirmUrl,
    "",
    `The link works once and expires in ${links.hours} hours. If you don't confirm, we delete this address when the link expires, and you won't hear from us again.`,
    "",
    "Rather leave now? Remove this address:",
    links.removeUrl,
    "",
    footerText(),
  ].join("\n");
  const html = layout("Confirm that you want to stay on the KalCode early-access list.", "Confirm your email", [
    {
      kind: "p",
      text: "This address joined the KalCode early-access list before we started confirming addresses. Please confirm that you want to stay on the list.",
    },
    { kind: "button", text: "Confirm my email", href: links.confirmUrl },
    {
      kind: "small",
      text: `The link works once and expires in ${links.hours} hours. If you don't confirm, we delete this address when the link expires, and you won't hear from us again.`,
    },
    {
      kind: "small",
      text: `Rather leave now? <a href="${escapeHtml(links.removeUrl)}" style="color:${ACCENT}">Remove this address</a>.`,
    },
  ]);
  return { subject, text, html };
}
