/**
 * Mobile navigation disclosure: the menu button toggles the nav panel, focus moves into the
 * panel on open, Escape or an outside click closes it, and focus returns to the button.
 */
const button = document.querySelector<HTMLButtonElement>("[data-menu-button]");
const nav = document.querySelector<HTMLElement>("[data-site-nav]");

if (button && nav) {
  const desktop = window.matchMedia("(min-width: 62rem)");

  const isOpen = () => button.getAttribute("aria-expanded") === "true";

  const open = () => {
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-label", "Close menu");
    nav.setAttribute("data-open", "");
    nav.querySelector<HTMLElement>("a")?.focus();
  };

  const close = (returnFocus: boolean) => {
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Menu");
    nav.removeAttribute("data-open");
    if (returnFocus) button.focus();
  };

  button.addEventListener("click", () => {
    if (isOpen()) close(true);
    else open();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      event.preventDefault();
      close(true);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Node | null;
    if (isOpen() && target && !nav.contains(target) && !button.contains(target)) {
      close(false);
    }
  });

  // Tabbing out of the open panel closes it, so it never hides content behind it.
  nav.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    if (isOpen() && !desktop.matches && next && !nav.contains(next) && !button.contains(next)) {
      close(false);
    }
  });

  desktop.addEventListener("change", () => {
    if (desktop.matches && isOpen()) close(false);
  });
}
