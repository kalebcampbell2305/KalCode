import { appendFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * The shared accessibility check for the desktop UI specs: WCAG 2.2 AA with no serious or critical
 * violation, and colour contrast that axe actually evaluated.
 *
 * Why the second half exists: axe reports colour contrast it cannot work out as "incomplete", and
 * incomplete is not a failure. When the shell's deep-space atmosphere was drawn with ::before and
 * ::after on the frame, axe saw a large pseudo-element above every text node in the app and gave
 * up on all of them ("pseudoContent"), so these specs silently stopped checking contrast anywhere in
 * the shell. The guard makes that a failure:
 *
 * 1. Inside the app shell ([data-app-shell]) axe must evaluate (pass or fail) at least one text
 *    node, so "nothing was checked" can never look green.
 * 2. Every colour-contrast node axe leaves incomplete, in the shell and in body-level portals
 *    (palette, menus, dialogs, toasts) alike, must have a reason in UNRESOLVABLE_CONTRAST below.
 *    Anything else, above all "pseudoContent", fails: draw decoration on an aria-hidden element
 *    instead (see .atmosphere in Shell.module.css).
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

/** The app shell's root (Shell.tsx). Portals render outside it, under <body>. */
export const APP_SHELL = "[data-app-shell]";

/**
 * The only reasons a colour-contrast node may stay incomplete (axe's `messageKey`). Each is a case
 * axe genuinely cannot compute from the DOM, not a structure we chose:
 * - bgImage / bgGradient: the text sits on a background image or gradient (panel sheen, the
 *   atmosphere wash, an empty state's star field); axe does not sample pixels.
 * - imgNode: the text sits over an <img>, <svg>, <canvas> or <video>.
 * - nonBmp: the text is only icon glyphs or emoji, which have no contrast to measure.
 *
 * Deliberately NOT here:
 * - pseudoContent: a large absolute ::before/::after with a background above the text. Draw the
 *   decoration on an aria-hidden element instead (the hairlines and rails across the app do).
 * - bgOverlap: another element is stacked above the text. Real overlapping UI is a bug to fix; so
 *   is decoration axe sorts above the text. axe 4.13 sorts an absolutely positioned child (even at
 *   z-index -1) above in-flow text of the same stacking context that has no positioned ancestor
 *   in between, so a full-area decoration sits behind content that is positioned or in its own
 *   stacking context (Shell's .atmosphere is a sibling before the frame; the sidebar footer is
 *   isolated; DashboardBoard positions .head's children). A thin edge never covers a text centre.
 * - shortTextContent: axe's label for a one-character text (a count badge, an initial, a "·")
 *   whose contrast it did not pass. That covers both a measured failure and a background it could
 *   not resolve, so it would hide real failures and real overlaps alike. The scan runs with
 *   ignoreLength instead (CONTRAST_CHECK below): one-character text is judged like any other, and
 *   lands in the normal pass, violation or reason buckets above.
 *
 * One kind of node is exempt by what it is, not by reason: text drawn inside an aria-hidden SVG
 * icon (ProviderGlyph's generic initial). It is part of a graphic, always next to the real name,
 * so WCAG 1.4.3 does not apply to it (1.4.11 non-text contrast does), and axe cannot place it:
 * it orders SVG shapes by CSS display, a <text> computes to block, and so it sorts the icon's
 * outline above the letter (bgOverlap). See `icon` below.
 *
 * And one narrow case of elmPartiallyObscured is allowed (`selfObscured` below): when the only
 * element axe blames is the text's own element. That is a pill or badge whose painted box is a
 * pixel shorter than its font's line box (the Agents count: a 13.8px pill around 15px of text),
 * so axe will not trust its background; nothing else covers the text. Any other element
 * partially covering text still fails.
 *
 * And elmPartiallyObscuring is re-checked rather than trusted (`belowOpaque` below). axe gives
 * that reason when the lines of a multi-line text have different element stacks, comparing each
 * stack all the way down to <html>. Over a dialog, a menu or a floating panel the lines always
 * differ beneath the surface (one line is over the thread list, the next over its header), which
 * cannot change the text's colours. The guard recomputes each line's stack with axe's own
 * function and cuts it at the first element with an opaque background: equal above that cut is
 * accepted; a difference above it (something really covering part of the text) still fails.
 */
export const UNRESOLVABLE_CONTRAST = new Set(["bgImage", "bgGradient", "imgNode", "nonBmp"]);

/**
 * axe skips judging one-character text by default (an icon-font ligature can look like a letter).
 * KalCode draws icons as SVG, so a single character is real text: digits in count badges,
 * initials, separators. Judge it (axe.run merges these with the check's default options).
 */
const CONTRAST_CHECK = { checks: { "color-contrast": { options: { ignoreLength: true } } } };

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type AxeNode = AxeResults["passes"][number]["nodes"][number];
type Status = "pass" | "violation" | "incomplete";

export type ContrastNode = {
  target: string;
  status: Status;
  inShell: boolean;
  /** Why axe left it incomplete (or failed it); undefined for a pass. */
  reason?: string;
  /** What axe blames: the pseudo-element's host or the background element. */
  related: string[];
  /** Text inside an aria-hidden SVG icon: part of a graphic (see UNRESOLVABLE_CONTRAST). */
  icon: boolean;
  /** elmPartiallyObscuring whose lines differ only beneath an opaque surface (see above). */
  belowOpaque: boolean;
};

const targetOf = (node: AxeNode) => node.target.map(String).join(" >>> ");

/** Every node axe's colour-contrast rule looked at, with whether it sits inside the app shell. */
export async function contrastNodes(page: Page, results: AxeResults): Promise<ContrastNode[]> {
  const nodes: { node: AxeNode; status: Status }[] = [];
  for (const [status, list] of [
    ["pass", results.passes],
    ["violation", results.violations],
    ["incomplete", results.incomplete],
  ] as const) {
    for (const rule of list) {
      if (rule.id !== "color-contrast") continue;
      for (const node of rule.nodes) nodes.push({ node, status });
    }
  }
  // Selectors from axe are a path through shadow roots: resolve each step, then test the shell.
  const paths = nodes.map(({ node }) => node.target.map(String));
  const places = await page.evaluate(
    ({ paths, shell }) =>
      paths.map((path) => {
        let root: Document | ShadowRoot = document;
        let el: Element | null = null;
        for (const selector of path) {
          el = root.querySelector(selector);
          if (!el) return { inShell: false, icon: false };
          if (el.shadowRoot) root = el.shadowRoot;
        }
        const icon = el instanceof SVGElement && el.tagName !== "svg" && !!el.closest('svg[aria-hidden="true"]');
        return { inShell: Boolean(el?.closest(shell)), icon };
      }),
    { paths, shell: APP_SHELL },
  );
  const reasonOf = (node: AxeNode) =>
    ((node.any.find((c) => c.id === "color-contrast") ?? node.any[0])?.data as { messageKey?: string } | undefined)
      ?.messageKey;
  // Re-check "the lines' stacks differ" with axe's own stack function, cut at the first opaque
  // background (only for that reason, and only for nodes outside shadow roots).
  const partial = nodes.flatMap(({ node, status }, index) =>
    status === "incomplete" && reasonOf(node) === "elmPartiallyObscuring" && node.target.length === 1
      ? [{ index, selector: String(node.target[0]) }]
      : [],
  );
  const opaqueAgrees = partial.length
    ? await page.evaluate(
        (selectors) => {
          type AxeGlobal = {
            setup: (node: Node) => void;
            teardown: () => void;
            commons: { dom: { getTextElementStack: (el: Element) => Element[][] } };
          };
          const axe = (window as unknown as { axe?: AxeGlobal }).axe;
          if (!axe) return selectors.map(() => false);
          const opaque = (el: Element) => {
            const style = getComputedStyle(el);
            const alpha = style.backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1]?.split(/[ ,/]+/)[3];
            return (
              style.opacity === "1" &&
              style.backgroundColor !== "transparent" &&
              (alpha === undefined || Number(alpha) === 1)
            );
          };
          const cut = (stack: Element[]) => {
            const at = stack.findIndex(opaque);
            return at === -1 ? stack : stack.slice(0, at + 1);
          };
          try {
            axe.setup(document);
          } catch {
            // already set up
          }
          try {
            return selectors.map((selector) => {
              const el = document.querySelector(selector);
              if (!el) return false;
              const stacks = axe.commons.dom.getTextElementStack(el).map(cut);
              const [first, ...rest] = stacks;
              return (
                first !== undefined && rest.every((s) => s.length === first.length && s.every((e, i) => e === first[i]))
              );
            });
          } finally {
            axe.teardown();
          }
        },
        partial.map((p) => p.selector),
      )
    : [];
  const belowOpaque = new Set(partial.filter((_, i) => opaqueAgrees[i]).map((p) => p.index));
  return nodes.map(({ node, status }, index) => {
    const check = node.any.find((c) => c.id === "color-contrast") ?? node.any[0];
    const data = (check?.data ?? {}) as { messageKey?: string };
    return {
      target: targetOf(node),
      status,
      inShell: places[index]?.inShell ?? false,
      icon: places[index]?.icon ?? false,
      belowOpaque: belowOpaque.has(index),
      reason: status === "pass" ? undefined : (data.messageKey ?? undefined),
      related: (check?.relatedNodes ?? []).map((n) => n.target.map(String).join(" >>> ")),
    };
  });
}

/** Counts per place and status, and incomplete reasons: the coverage numbers worth reporting. */
export function contrastSummary(nodes: ContrastNode[]) {
  const count = (inShell: boolean, status: Status) =>
    nodes.filter((n) => n.inShell === inShell && n.status === status).length;
  const reasons: Record<string, number> = {};
  for (const n of nodes) {
    if (n.status !== "incomplete") continue;
    const key = `${n.inShell ? "shell" : "portal"}:${n.reason ?? "unknown"}`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  return {
    shell: { pass: count(true, "pass"), violation: count(true, "violation"), incomplete: count(true, "incomplete") },
    portal: {
      pass: count(false, "pass"),
      violation: count(false, "violation"),
      incomplete: count(false, "incomplete"),
    },
    reasons,
  };
}

/** Fails when colour contrast went unchecked for a reason we control (see the file comment). */
export async function expectContrastEvaluated(page: Page, results: AxeResults, where = "") {
  const nodes = await contrastNodes(page, results);
  const summary = contrastSummary(nodes);
  // Optional audit trail: KALCODE_A11Y_REPORT=<file> appends one JSON line per scan.
  const report = process.env.KALCODE_A11Y_REPORT;
  if (report) {
    // What the incomplete nodes sit on: "<place>:<reason> <- <element axe blames>".
    const blamed: Record<string, number> = {};
    for (const n of nodes) {
      if (n.status !== "incomplete") continue;
      const tag = n.icon ? "icon:" : n.belowOpaque ? "belowOpaque:" : "";
      const key = `${n.inShell ? "shell" : "portal"}:${tag}${n.reason ?? "unknown"} <- ${n.related[0] ?? "?"}`;
      blamed[key] = (blamed[key] ?? 0) + 1;
    }
    const line = { test: test.info().titlePath.join(" › "), where, ...summary, blamed };
    appendFileSync(report, `${JSON.stringify(line)}\n`);
  }
  const label = where ? `${where}: ` : "";
  const selfObscured = (n: ContrastNode) =>
    n.reason === "elmPartiallyObscured" && n.related.length === 1 && n.related[0] === n.target;
  const unexplained = nodes.filter(
    (n) =>
      n.status === "incomplete" &&
      !n.icon &&
      !selfObscured(n) &&
      !n.belowOpaque &&
      !(n.reason && UNRESOLVABLE_CONTRAST.has(n.reason)),
  );
  expect(
    unexplained.map(({ target, inShell, reason, related }) => ({ target, inShell, reason, related })),
    `${label}colour contrast left incomplete for a reason axe can resolve (pseudoContent means a large ::before/::after above the text; draw it on an aria-hidden element)`,
  ).toEqual([]);
  const shellEvaluated = summary.shell.pass + summary.shell.violation;
  const hasShell = (await page.locator(APP_SHELL).count()) > 0;
  if (hasShell) {
    expect(
      shellEvaluated,
      `${label}axe evaluated no colour contrast inside the app shell (${JSON.stringify(summary)})`,
    ).toBeGreaterThan(0);
  }
}

/**
 * Puts the page in a state every scan judges the same way. Playwright leaves the pointer wherever
 * it last clicked, and the Tooltip under it opens 350 ms later (or one under a view that remounts
 * beneath a still pointer): when that lands inside axe's run, a tooltip half way through its
 * entrance is scanned (lane 10 gate run 37417037628: a tooltip "partially obscured" by the brand
 * lettering, green on retry). So park the pointer on the brand mark, which has no hover UI (its
 * pointerleave also cancels a pending tooltip), and let finite animations finish: a tooltip
 * leaving, a menu or dialog entering. A tooltip opened by keyboard focus stays and is judged.
 */
async function settleForScan(page: Page) {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY);
    const timeout = new Promise((resolve) => setTimeout(resolve, 2_000));
    await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => undefined))), timeout]);
  });
}

/** axe's colour-contrast run died on a node it could not place on its grid (see below). */
function gridBoundsFailure(results: AxeResults): string | null {
  const node = results.incomplete
    .find((r) => r.id === "color-contrast")
    ?.nodes.find(
      (n) =>
        n.target.length === 1 &&
        n.none.some(
          (c) => c.id === "error-occurred" && /grid bounds/.test(String((c.data as { message?: string })?.message)),
        ),
    );
  return node ? String(node.target[0]) : null;
}

/**
 * axe 4.13 throws "Element midpoint exceeds the grid bounds" when a text node sits on the very edge
 * of the window (a rounding error in its grid), and then skips colour contrast for the WHOLE page:
 * one row at the bottom edge left every other text node unjudged. When that happens the offending
 * element is scrolled to the middle of its scroller and colour contrast is run again for the whole
 * page (up to three times, in case another node lands on an edge), and that run's colour-contrast
 * results replace the failed ones. Every scroll position is put back afterwards.
 */
async function recheckGridBounds(page: Page, results: AxeResults): Promise<AxeResults> {
  let failed = gridBoundsFailure(results);
  if (!failed) return results;
  await page.evaluate(() => {
    const saved: [Element, number, number][] = [];
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollTop || el.scrollLeft) saved.push([el, el.scrollTop, el.scrollLeft]);
    }
    (window as unknown as { __kcScroll?: unknown }).__kcScroll = { saved, x: window.scrollX, y: window.scrollY };
  });
  try {
    for (let attempt = 0; failed && attempt < 3; attempt += 1) {
      await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), failed);
      const again = await new AxeBuilder({ page })
        .options(CONTRAST_CHECK as Parameters<AxeBuilder["options"]>[0])
        .withRules(["color-contrast"])
        .analyze();
      for (const key of ["passes", "violations", "incomplete"] as const) {
        results[key] = [...results[key].filter((r) => r.id !== "color-contrast"), ...again[key]];
      }
      failed = gridBoundsFailure(results);
    }
  } finally {
    await page.evaluate(() => {
      const w = window as unknown as { __kcScroll?: { saved: [Element, number, number][]; x: number; y: number } };
      const state = w.__kcScroll;
      if (!state) return;
      for (const el of document.querySelectorAll("*")) {
        if (el.scrollTop || el.scrollLeft) {
          el.scrollTop = 0;
          el.scrollLeft = 0;
        }
      }
      for (const [el, top, left] of state.saved) {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
      window.scrollTo(state.x, state.y);
      delete w.__kcScroll;
    });
  }
  return results;
}

/** Full-page WCAG 2.2 AA: no serious or critical violation, and contrast actually evaluated. */
export async function expectNoSeriousA11yViolations(page: Page, where = "") {
  await settleForScan(page);
  // options() replaces the run options, so it goes before withTags (which adds runOnly to them).
  const results = await new AxeBuilder({ page })
    .options(CONTRAST_CHECK as Parameters<AxeBuilder["options"]>[0])
    .withTags(WCAG_TAGS)
    .analyze()
    .then((raw) => recheckGridBounds(page, raw));
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious,
    `${where ? `${where}: ` : ""}${JSON.stringify(
      serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      null,
      2,
    )}`,
  ).toEqual([]);
  await expectContrastEvaluated(page, results, where);
}
