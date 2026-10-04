/**
 * Actions shared by the quick bar and the What's Happening strip. Each one shows existing work or
 * goes through the path that already guards it: re-running tests enqueues the newest test task
 * through Operations, which asks for native confirmation before anything runs.
 */
import type { OperationsSnapshot, PaneContent } from "@kalcode/protocol";
import type { OperationsApi } from "../../../ipc/operations.ts";
import type { PaneController } from "../../../shell/panes/usePaneController.ts";
import { browserContent } from "../../browser/index.ts";
import { codeContextOperationsContent, requestCodeContextTab } from "../CodeContextOperations.tsx";
import { latestTestRun, type OrgItem } from "./model.ts";

/** Shows content beside the work (a split) and focuses it. */
export function showBeside(controller: PaneController, content: PaneContent) {
  controller.show(content, { placement: "split", focus: true });
}

/** Opens Runs & services on its Tests tab. */
export function openTests(controller: PaneController) {
  requestCodeContextTab("tests");
  showBeside(controller, codeContextOperationsContent());
}

/** Opens the Browser beside the work, on an address when given. */
export function openBrowser(controller: PaneController, url: string | null = null) {
  showBeside(controller, browserContent(undefined, url));
}

/** Shows the first item with one of the badges (in stack order); false when there is none. */
export function showFirst(
  controller: PaneController,
  items: readonly OrgItem[],
  badges: readonly string[],
  kind?: OrgItem["kind"],
): boolean {
  const target = items.find(
    (item) => (!kind || item.kind === kind) && item.status && badges.includes(item.status.badge),
  );
  if (!target) return false;
  controller.show(target.content, { focus: true });
  return true;
}

/** The test task Run Tests repeats: the workspace's newest test run that has a command. */
export function repeatableTestRun(operations: OperationsSnapshot | null) {
  const run = latestTestRun(operations);
  return run?.spec.command ? run : undefined;
}

/**
 * Runs the workspace's tests again: enqueues the newest test task (Operations asks before it
 * runs) and shows the Tests tab. With no test task yet, it only opens the Tests tab.
 */
export async function runTests(
  controller: PaneController,
  operations: OperationsSnapshot | null,
  client: OperationsApi,
): Promise<"queued" | "opened"> {
  const run = repeatableTestRun(operations);
  if (!run) {
    openTests(controller);
    controller.announce("No test task yet. Add one in Tests, then Run Tests repeats it.");
    return "opened";
  }
  await client.enqueue(run.spec);
  openTests(controller);
  controller.announce(`${run.spec.name} queued.`);
  return "queued";
}
