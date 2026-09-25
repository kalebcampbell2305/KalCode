/**
 * The confirm and remove pages opened from our emails. Reads the link's code from `?token=`,
 * and POSTs it only when the person presses the button: a GET of the page (by a link scanner,
 * a mail preview or a prefetch) never confirms or removes anything.
 */
import { EARLY_ACCESS_EMAIL } from "../lib/site";

type Action = "confirm" | "remove";
type Next = "done" | "retry" | null;

const CODE = /^[A-Za-z0-9_-]{43}$/;
const HOURS = EARLY_ACCESS_EMAIL.linkTtlHours;

const MESSAGES = {
  confirm: {
    ok: "Your email is confirmed. You're on the KalCode early-access list, and we'll email you when there is a build to try.",
    invalid: `This confirmation link is no longer valid. Links work once and expire after ${HOURS} hours. Join again to get a new one.`,
    missing:
      "This page opens from the link in your confirmation email. Open that link again, or join again to get a new one.",
    busy: "Confirming…",
  },
  remove: {
    ok: "Your email has been removed from the early-access list. We won't email you again.",
    invalid: `This removal link is no longer valid. Links work once and expire after ${HOURS} hours. Request a new one on the privacy page.`,
    missing:
      "This page opens from the link in your removal email. Open that link again, or request a new one on the privacy page.",
    busy: "Removing…",
  },
  rateLimited: "Too many attempts from your network. Wait a minute and try again.",
  network: "We couldn't reach kalcoded.com. Check your connection and try again.",
  server: "Something went wrong on our side, and nothing changed. Try again in a few minutes.",
} as const;

function init(root: HTMLElement): void {
  const action = root.dataset.emailAction as Action | undefined;
  const endpoint = root.dataset.endpoint;
  if ((action !== "confirm" && action !== "remove") || !endpoint) return;
  const form = root.querySelector<HTMLFormElement>("form");
  const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const status = root.querySelector<HTMLElement>('[role="status"]');
  if (!form || !button || !status) return;
  const text = MESSAGES[action];
  const buttonLabel = button.textContent ?? "";

  const finish = (state: "success" | "error", message: string, next: Next, moveFocus: boolean) => {
    status.dataset.state = state;
    status.textContent = message;
    for (const block of root.querySelectorAll<HTMLElement>("[data-next]")) {
      block.hidden = block.dataset.next !== next;
    }
    if (next !== null) {
      form.hidden = true;
      if (moveFocus) status.focus();
    }
  };

  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  if (!CODE.test(token)) {
    finish("error", text.missing, "retry", false);
    return;
  }

  let busy = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = text.busy;
    form.setAttribute("aria-busy", "true");
    status.dataset.state = "pending";
    status.textContent = "";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        credentials: "same-origin",
      });
      if (response.ok) finish("success", text.ok, "done", true);
      else if (response.status === 410 || response.status === 400) finish("error", text.invalid, "retry", true);
      else if (response.status === 429) finish("error", MESSAGES.rateLimited, null, false);
      else finish("error", MESSAGES.server, null, false);
    } catch {
      finish("error", MESSAGES.network, null, false);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = buttonLabel;
      form.removeAttribute("aria-busy");
    }
  });
}

for (const root of document.querySelectorAll<HTMLElement>("[data-email-action]")) {
  init(root);
}
