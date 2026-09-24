/**
 * Theme control. The inline head script has already applied the stored preference before
 * paint; this module wires the System / Light / Dark buttons and follows OS changes while the
 * preference is "system".
 */
import { THEME_STORAGE_KEY } from "../lib/theme-script";

type Preference = "system" | "light" | "dark";

const root = document.documentElement;
const media = window.matchMedia("(prefers-color-scheme: light)");

function readPreference(): Preference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage can be unavailable (private mode, blocked site data); fall back to system.
  }
  return "system";
}

function writePreference(preference: Preference): void {
  try {
    if (preference === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Not persisted; the choice still applies to this page view.
  }
}

function apply(preference: Preference): void {
  const theme = preference === "system" ? (media.matches ? "light" : "dark") : preference;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-theme-preference", preference);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === preference));
  }
}

let preference = readPreference();
apply(preference);

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
  button.addEventListener("click", () => {
    const choice = button.dataset.themeChoice;
    if (choice !== "system" && choice !== "light" && choice !== "dark") return;
    preference = choice;
    writePreference(preference);
    apply(preference);
  });
}

media.addEventListener("change", () => {
  if (preference === "system") apply(preference);
});

// Keep multiple tabs in sync.
window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY || event.key === null) {
    preference = readPreference();
    apply(preference);
  }
});
