import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** Places that stay in the Primary sidebar itself; every other surface is in its More menu. */
const IN_SIDEBAR = new Set(["Code", "Activity", "Settings", "Home", "Project"]);

/**
 * Opens a place from the Primary sidebar: Code, Activity and Settings directly, every other surface
 * (Operations, KalVoice, Threads, Unified Memory, Providers, Browser) through the More menu.
 */
export async function goTo(user: UserEvent, name: string): Promise<void> {
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  if (IN_SIDEBAR.has(name)) {
    await user.click(primary.getByRole("button", { name }));
    return;
  }
  await user.click(primary.getByRole("button", { name: /^More places/ }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

/** The menu items More offers (opens the menu; Escape closes it). */
export async function morePlaces(user: UserEvent): Promise<string[]> {
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  await user.click(primary.getByRole("button", { name: /^More places/ }));
  const menu = await screen.findByRole("menu");
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}
