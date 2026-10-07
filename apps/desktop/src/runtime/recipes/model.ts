import type {
  LaunchRecipe,
  PaneContent,
  ProviderAccount,
  RecipeComponent,
  RecipeVariable,
  Workspace,
} from "@kalcode/protocol";

/**
 * Launch Recipes (pure model). A Recipe is a saved working desk that only REFERENCES canonical
 * objects (project, provider account, Squad) by id. Preflight resolves those references against
 * live state without starting anything, so the launch sheet can say exactly what cannot start
 * and offer the shortest repair before a single process exists.
 */

export const RECIPE_SCHEMA_VERSION = 1;
export const RECIPE_LAYOUTS = ["two", "three", "four", "six"] as const;
export type RecipeLayout = (typeof RECIPE_LAYOUTS)[number];
/** A launch with at least this many coding agents is previewed before it starts. */
export const LARGE_AGENT_COUNT = 6;
export const MAX_RECIPE_COMPONENTS = 32;
export const MAX_RECIPE_VARIABLES = 8;

const VARIABLE = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;
export const VARIABLE_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** Replaces `{{key}}` with its value; unknown keys stay visible so the problem is obvious. */
export function substitute(template: string, values: Readonly<Record<string, string>>): string {
  // Own keys only: `{{constructor}}` must never resolve to an inherited Object property.
  return template.replace(VARIABLE, (whole, key: string) => (Object.hasOwn(values, key) ? (values[key] ?? "") : whole));
}

/** Every `{{key}}` a Recipe uses, in first-use order. */
export function referencedVariables(recipe: Pick<LaunchRecipe, "components">): string[] {
  const keys = new Set<string>();
  for (const text of componentTemplates(recipe.components))
    for (const match of text.matchAll(VARIABLE)) keys.add(match[1] as string);
  return [...keys];
}

function componentTemplates(components: readonly RecipeComponent[]): string[] {
  const out: string[] = [];
  for (const c of components) {
    if (c.kind === "agent") out.push(c.name ?? "", c.task ?? "");
    if (c.kind === "terminal") out.push(c.name ?? "", c.command ?? "");
    if (c.kind === "browser") out.push(c.url);
    if (c.kind === "service") out.push(c.name, c.command);
    if (c.kind === "squad") out.push(c.goal ?? "");
  }
  return out;
}

/** Default values, overlaid by what the person typed for this launch only. */
export function launchValues(
  variables: readonly RecipeVariable[],
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of variables)
    values[variable.key] = Object.hasOwn(overrides, variable.key)
      ? (overrides[variable.key] ?? variable.defaultValue)
      : variable.defaultValue;
  return values;
}

/** HTTP(S) only, no embedded credentials, no sign-in tokens in the address. */
export function safeRecipeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  for (const key of url.searchParams.keys())
    if (/token|secret|password|passwd|api[-_]?key|signature|^sig$|^code$|session|auth/i.test(key)) return null;
  return url.toString();
}

export function componentLabel(component: RecipeComponent, values: Readonly<Record<string, string>> = {}): string {
  switch (component.kind) {
    case "agent":
      return component.name ? substitute(component.name, values) : `${providerName(component.providerId)} agent`;
    case "terminal":
      return component.name ? substitute(component.name, values) : "Terminal";
    case "browser": {
      const url = substitute(component.url, values);
      try {
        return new URL(url).host || url;
      } catch {
        return url;
      }
    }
    case "service":
      return substitute(component.name, values);
    case "widget":
      return widgetName(component.widget);
    case "squad":
      return "Squad";
  }
}

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "gemini-cli": "Gemini",
};
export const providerName = (id: string) => PROVIDER_NAMES[id] ?? id;
const widgetName = (id: string) =>
  id
    .split(/[-_:]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");

export type RecipeRepair =
  /** Sign the exact saved account in again; the launch waits and resumes. */
  | { kind: "reconnect"; providerId: string; accountId: string }
  /** The saved account is gone: pick another for this provider (this launch only, or save it). */
  | { kind: "choose-account"; providerId: string }
  /** The Recipe's project is missing or its folder is unavailable. */
  | { kind: "open-project"; workspaceId: string | null }
  /** Nothing to fix from here: edit the Recipe or skip the part. */
  | { kind: "edit" };

export interface RecipeBlocker {
  componentKey: string | null;
  title: string;
  detail: string;
  repair: RecipeRepair;
  /** Whether the rest of the desk can start without this part. */
  skippable: boolean;
}

export interface RecipeLaunchInputs {
  /** Per-launch variable values (never written back to the Recipe). */
  values?: Readonly<Record<string, string>>;
  /** Component keys the person chose to skip for this launch. */
  skip?: readonly string[];
  /** Per-launch account choices by agent component key. */
  accounts?: Readonly<Record<string, string>>;
}

export interface RecipeEnvironment {
  /** Project used when the Recipe names none. */
  activeWorkspaceId: string | null;
  workspaces: readonly Workspace[];
  accounts: readonly ProviderAccount[];
  /** Providers this build can start as real coding terminals, validated at runtime. */
  agentProviders: readonly string[];
  /** Saved Squads by id; null when Squads aren't available on this plan or build. */
  squadIds: ReadonlySet<string> | null;
  /** The account a provider uses when the Recipe names none (remembered → default → only). */
  defaultAccount: (providerId: string) => ProviderAccount | null;
}

/** One part ready to start, with every template already filled. */
export type PlannedComponent =
  | {
      kind: "agent";
      key: string;
      label: string;
      providerId: string;
      account: ProviderAccount;
      model: string | null;
      effort: string | null;
      name: string | null;
      task: string | null;
    }
  | { kind: "terminal"; key: string; label: string; name: string | null; command: string | null }
  | { kind: "browser"; key: string; label: string; url: string }
  | { kind: "service"; key: string; label: string; name: string; command: string }
  | { kind: "widget"; key: string; label: string; widget: string }
  | { kind: "squad"; key: string; label: string; squadId: string; goal: string | null };

export interface RecipePreflight {
  recipe: LaunchRecipe;
  workspace: Workspace | null;
  values: Record<string, string>;
  /** Variables the person is asked for at launch. */
  ask: RecipeVariable[];
  blockers: RecipeBlocker[];
  /** Why the launch is previewed instead of starting at once (empty → launch immediately). */
  consequences: string[];
  plan: PlannedComponent[];
  /** Parts the person skipped for this launch (they stay in the Recipe). */
  skipped: SkippedComponent[];
  layout: RecipeLayout | null;
}

export interface SkippedComponent {
  key: string;
  label: string;
  reason: string;
}

/**
 * Resolves a Recipe against live state. Starts nothing. A blocked component is reported once with
 * its repair; components the person skipped are left out of the plan.
 */
export function preflightRecipe(
  recipe: LaunchRecipe,
  env: RecipeEnvironment,
  inputs: RecipeLaunchInputs = {},
): RecipePreflight {
  const values = launchValues(recipe.variables, inputs.values);
  const skip = new Set(inputs.skip ?? []);
  const blockers: RecipeBlocker[] = [];
  const plan: PlannedComponent[] = [];
  const skipped: SkippedComponent[] = [];
  const workspaceId = recipe.workspaceId ?? env.activeWorkspaceId;
  const workspace = env.workspaces.find((item) => item.id === workspaceId) ?? null;
  if (recipe.schemaVersion > RECIPE_SCHEMA_VERSION) {
    blockers.push({
      componentKey: null,
      title: "Made by a newer KalCode",
      detail: "Update KalCode to launch this Recipe. It is kept unchanged.",
      repair: { kind: "edit" },
      skippable: false,
    });
  }
  if (!workspace?.available) {
    blockers.push({
      componentKey: null,
      title: workspace ? `${workspace.name} is unavailable` : "No project to launch in",
      detail: workspace
        ? "Its folder can't be reached. Reconnect the folder, then launch again."
        : recipe.workspaceId
          ? "This Recipe's project was removed. Open the folder again or edit the Recipe."
          : "Open a project first. This Recipe launches in the active project.",
      repair: { kind: "open-project", workspaceId: recipe.workspaceId },
      skippable: false,
    });
  }
  for (const component of recipe.components) {
    if (skip.has(component.key)) {
      skipped.push({ key: component.key, label: componentLabel(component, values), reason: "Skipped for this launch" });
      continue;
    }
    const label = componentLabel(component, values);
    const block = (title: string, detail: string, repair: RecipeRepair) =>
      blockers.push({ componentKey: component.key, title, detail, repair, skippable: true });
    switch (component.kind) {
      case "agent": {
        if (!env.agentProviders.includes(component.providerId)) {
          block(
            `${label} can't start`,
            `${providerName(component.providerId)} can't run as a coding terminal in this build. Skip it or edit the Recipe.`,
            { kind: "edit" },
          );
          break;
        }
        const chosenId = inputs.accounts?.[component.key] ?? component.providerAccountId;
        const account = chosenId
          ? env.accounts.find((a) => a.id === chosenId && a.providerId === component.providerId && !a.archivedAt)
          : env.defaultAccount(component.providerId);
        if (!account) {
          block(
            chosenId ? `${label}: account removed` : `${label}: choose an account`,
            chosenId
              ? `The saved ${providerName(component.providerId)} account no longer exists. Choose another account.`
              : `No ${providerName(component.providerId)} account is signed in yet. Choose or add one.`,
            { kind: "choose-account", providerId: component.providerId },
          );
          break;
        }
        // Only a provider-reported sign-out blocks; unknown plan/usage never does.
        if (account.authenticationState === "not_authenticated") {
          block(
            `${account.displayName} needs to reconnect`,
            `${providerName(component.providerId)} reported this account signed out. Reconnect it and the launch continues.`,
            { kind: "reconnect", providerId: component.providerId, accountId: account.id },
          );
          break;
        }
        plan.push({
          kind: "agent",
          key: component.key,
          label,
          providerId: component.providerId,
          account,
          model: component.model,
          effort: component.effort,
          name: component.name ? substitute(component.name, values) : null,
          task: component.task ? substitute(component.task, values).trim() || null : null,
        });
        break;
      }
      case "terminal":
        plan.push({
          kind: "terminal",
          key: component.key,
          label,
          name: component.name ? substitute(component.name, values) : null,
          command: component.command ? substitute(component.command, values).trim() || null : null,
        });
        break;
      case "browser": {
        const url = safeRecipeUrl(substitute(component.url, values));
        if (!url) {
          block(
            `${label} can't open`,
            "Browser parts need an HTTP or HTTPS address without credentials or sign-in tokens.",
            { kind: "edit" },
          );
          break;
        }
        plan.push({ kind: "browser", key: component.key, label, url });
        break;
      }
      case "service": {
        const command = substitute(component.command, values).trim();
        if (!command) {
          block(`${label} has no command`, "Add the command that starts this Service.", { kind: "edit" });
          break;
        }
        plan.push({ kind: "service", key: component.key, label, name: substitute(component.name, values), command });
        break;
      }
      case "widget":
        plan.push({ kind: "widget", key: component.key, label, widget: component.widget });
        break;
      case "squad":
        if (!env.squadIds) {
          block("Squads aren't available", "Squads need KalCode MAX. Skip the Squad to launch the rest.", {
            kind: "edit",
          });
        } else if (!env.squadIds.has(component.squadId)) {
          block("Squad removed", "The saved Squad no longer exists. Skip it or choose another in the Recipe.", {
            kind: "edit",
          });
        } else {
          plan.push({
            kind: "squad",
            key: component.key,
            label,
            squadId: component.squadId,
            goal: component.goal ? substitute(component.goal, values).trim() || null : null,
          });
        }
        break;
    }
  }
  const ask = recipe.variables.filter((variable) => variable.askAtLaunch);
  const consequences: string[] = [];
  const agents = plan.filter((part) => part.kind === "agent").length;
  if (agents >= LARGE_AGENT_COUNT) consequences.push(`Starts ${agents} coding agents`);
  if (plan.some((part) => part.kind === "squad")) consequences.push("Launches a Squad that queues its own agents");
  const services = plan.filter((part) => part.kind === "service").length;
  if (services > 0) consequences.push(services === 1 ? "Starts a Service" : `Starts ${services} Services`);
  const layout = (RECIPE_LAYOUTS as readonly string[]).includes(recipe.layout ?? "")
    ? (recipe.layout as RecipeLayout)
    : null;
  return { recipe, workspace, values, ask, blockers, consequences, plan, skipped, layout };
}

/** Launch at once only when nothing needs the person: no question, blocker or consequence. */
export function launchesImmediately(preflight: RecipePreflight): boolean {
  return preflight.ask.length === 0 && preflight.blockers.length === 0 && preflight.consequences.length === 0;
}

/** Where a started part lives, so the summary links straight to it. */
export type RecipeLink =
  | { kind: "pane"; content: PaneContent }
  | { kind: "service"; runId: string }
  | { kind: "squad"; launchId: string };

export interface StartedComponent {
  key: string;
  kind: PlannedComponent["kind"];
  label: string;
  link: RecipeLink | null;
  /** Reused an already-running Service instead of starting a duplicate. */
  reused?: boolean;
  /** Started, with a caveat worth reading (for example, the first task wasn't sent). */
  note?: string;
}

export interface FailedComponent {
  key: string;
  kind: PlannedComponent["kind"];
  label: string;
  reason: string;
}

export interface RecipeLaunchSummary {
  recipeId: string;
  recipeName: string;
  workspaceId: string;
  started: StartedComponent[];
  failed: FailedComponent[];
  /** Parts that didn't start because they were skipped or still blocked, with why. */
  skipped: SkippedComponent[];
  /** One sentence about the launch as a whole (cancelled, blocked, desk couldn't be shown). */
  notice: string | null;
  durationMs: number;
}

/** Sorted for every list: pinned first, then manual position, then name. */
export function sortRecipes(recipes: readonly LaunchRecipe[]): LaunchRecipe[] {
  return [...recipes].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      a.position - b.position ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** Exact id, else a unique case-insensitive name (KalVoice, palette): never a guess. */
export function resolveRecipeQuery(
  recipes: readonly LaunchRecipe[],
  query: string,
): { kind: "found"; recipe: LaunchRecipe } | { kind: "ambiguous"; matches: LaunchRecipe[] } | { kind: "missing" } {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { kind: "missing" };
  const byId = recipes.find((recipe) => recipe.id === query.trim());
  if (byId) return { kind: "found", recipe: byId };
  const exact = recipes.filter((recipe) => recipe.name.toLocaleLowerCase() === needle);
  if (exact.length === 1) return { kind: "found", recipe: exact[0] as LaunchRecipe };
  if (exact.length > 1) return { kind: "ambiguous", matches: exact };
  const partial = recipes.filter((recipe) => recipe.name.toLocaleLowerCase().includes(needle));
  if (partial.length === 1) return { kind: "found", recipe: partial[0] as LaunchRecipe };
  return partial.length > 1 ? { kind: "ambiguous", matches: partial } : { kind: "missing" };
}

/** A blank Recipe for the editor (native assigns nothing; ids are client-generated v4). */
export function emptyRecipe(id: string, workspaceId: string | null, position: number): LaunchRecipe {
  return {
    id,
    name: "",
    schemaVersion: RECIPE_SCHEMA_VERSION,
    workspaceId,
    pinned: false,
    position,
    variables: [],
    components: [],
    layout: null,
    updatedAt: "",
  };
}

/** A copy with a fresh id and a distinct name ("Name copy", "Name copy 2"). */
export function duplicateRecipe(
  recipe: LaunchRecipe,
  id: string,
  existing: readonly LaunchRecipe[],
  position: number,
): LaunchRecipe {
  const taken = new Set(existing.map((item) => item.name.toLocaleLowerCase()));
  // Trim the base, never the suffix, so every candidate stays distinct within 120 characters.
  const candidate = (n: number) => {
    const suffix = n === 1 ? " copy" : ` copy ${n}`;
    return `${recipe.name.slice(0, 120 - suffix.length).trimEnd()}${suffix}`;
  };
  let n = 1;
  while (taken.has(candidate(n).toLocaleLowerCase())) n += 1;
  const name = candidate(n);
  return { ...structuredClone(recipe), id, name, pinned: false, position, updatedAt: "" };
}
