/**
 * Progressive enhancement for the early-access and removal forms: client-side validation with
 * the same rules as the Worker, JSON submission, and clear inline states announced politely.
 */
import { isValidEmail, normalizeEmail } from "../lib/email";

type Kind = "signup" | "remove";

const ENDPOINTS: Record<Kind, string> = {
  signup: "/api/early-access",
  remove: "/api/early-access/remove",
};

const MESSAGES = {
  empty: "Enter your email address.",
  invalid: "Enter a complete email address, like name@example.com.",
  rateLimited: "Too many attempts from your network. Wait a minute and try again.",
  network: "We couldn't reach kalcoded.com. Check your connection and try again.",
  server: "Something went wrong on our side, and nothing was saved. Try again in a few minutes.",
  signupOk: "You're on the list. We'll email you when there is a build to try.",
  removeOk: "If that address was on the early-access list, it has been removed.",
} as const;

function setStatus(status: HTMLElement, state: "error" | "success" | "pending", text: string): void {
  status.dataset.state = state;
  status.textContent = text;
}

function enhance(form: HTMLFormElement): void {
  const kind = form.dataset.apiForm as Kind | undefined;
  if (kind !== "signup" && kind !== "remove") return;

  const input = form.querySelector<HTMLInputElement>('input[name="email"]');
  const trap = form.querySelector<HTMLInputElement>('input[name="website"]');
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const status = form.querySelector<HTMLElement>('[role="status"]');
  if (!input || !button || !status) return;

  const buttonLabel = button.textContent ?? "";
  let busy = false;

  const markInvalid = (invalid: boolean) => {
    if (invalid) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };

  input.addEventListener("input", () => {
    if (input.getAttribute("aria-invalid") === "true") {
      markInvalid(false);
      status.textContent = "";
      delete status.dataset.state;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;

    const email = normalizeEmail(input.value);
    if (!email || !isValidEmail(email)) {
      markInvalid(true);
      setStatus(status, "error", email ? MESSAGES.invalid : MESSAGES.empty);
      input.focus();
      return;
    }
    markInvalid(false);

    busy = true;
    button.disabled = true;
    button.textContent = kind === "signup" ? "Joining…" : "Removing…";
    form.setAttribute("aria-busy", "true");
    setStatus(status, "pending", "");

    const payload =
      kind === "signup" ? { email, source: form.dataset.source ?? null, website: trap?.value ?? "" } : { email };

    try {
      const response = await fetch(ENDPOINTS[kind], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
      });
      if (response.ok) {
        setStatus(status, "success", kind === "signup" ? MESSAGES.signupOk : MESSAGES.removeOk);
        input.value = "";
      } else if (response.status === 429) {
        setStatus(status, "error", MESSAGES.rateLimited);
      } else if (response.status === 400) {
        markInvalid(true);
        setStatus(status, "error", MESSAGES.invalid);
        input.focus();
      } else {
        setStatus(status, "error", MESSAGES.server);
      }
    } catch {
      setStatus(status, "error", MESSAGES.network);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = buttonLabel;
      form.removeAttribute("aria-busy");
    }
  });
}

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-api-form]")) {
  enhance(form);
}
