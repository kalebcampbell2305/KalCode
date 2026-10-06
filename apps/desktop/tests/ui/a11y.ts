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
 */
export const UNRESOLVABLE_CONTRAST = new Set(["bgImage", "bgGradient", "imgNode", "nonBmp"]);

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
  const inShell = await page.evaluate(
    ({ paths, shell }) =>
      paths.map((path) => {
        let root: Document | ShadowRoot = document;
        let el: Element | null = null;
        for (const selector of path) {
          el = root.querySelector(selector);
          if (!el) return false;
          if (el.shadowRoot) root = el.shadowRoot;
        }
        return Boolean(el?.closest(shell));
      }),
    { paths, shell: APP_SHELL },
  );
  return nodes.map(({ node, status }, index) => {
    const check = node.any.find((c) => c.id === "color-contrast") ?? node.any[0];
    const data = (check?.data ?? {}) as { messageKey?: string };
    return {
      target: targetOf(node),
      status,
      inShell: inShell[index] ?? false,
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
      const key = `${n.inShell ? "shell" : "portal"}:${n.reason ?? "unknown"} <- ${n.related[0] ?? "?"}`;
      blamed[key] = (blamed[key] ?? 0) + 1;
    }
    const line = { test: test.info().titlePath.join(" › "), where, ...summary, blamed };
    appendFileSync(report, `${JSON.stringify(line)}\n`);
  }
  const label = where ? `${where}: ` : "";
  const unexplained = nodes.filter(
    (n) => n.status === "incomplete" && !(n.reason && UNRESOLVABLE_CONTRAST.has(n.reason)),
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

/** Full-page WCAG 2.2 AA: no serious or critical violation, and contrast actually evaluated. */
export async function expectNoSeriousA11yViolations(page: Page, where = "") {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
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
