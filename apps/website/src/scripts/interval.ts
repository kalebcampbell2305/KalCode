/**
 * Monthly / Yearly switching for IntervalToggle.astro. Elements marked `data-show="month"` or
 * `data-show="year"` are shown only for that interval; the server renders the monthly state.
 */
import type { BillingInterval } from "@kalcode/protocol/plans";

export function applyInterval(interval: BillingInterval, root: ParentNode = document): void {
  for (const option of root.querySelectorAll<HTMLButtonElement>("[data-interval-option]")) {
    option.setAttribute("aria-pressed", String(option.dataset.intervalOption === interval));
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-show]")) {
    element.hidden = element.dataset.show !== interval;
  }
}

export function onIntervalChange(listener: (interval: BillingInterval) => void, root: ParentNode = document): void {
  for (const option of root.querySelectorAll<HTMLButtonElement>("[data-interval-option]")) {
    option.addEventListener("click", () => {
      const interval = option.dataset.intervalOption === "year" ? "year" : "month";
      applyInterval(interval, root);
      listener(interval);
    });
  }
}
