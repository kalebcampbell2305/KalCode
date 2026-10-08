import type {
  LaunchRecipe,
  ProviderAccount,
  ProviderAccountBinding,
  RecipeComponent,
  RecipeVariable,
  SquadDefinition,
} from "@kalcode/protocol";
import { Button, Field, IconButton, ProviderGlyph, Select, TextArea, TextInput } from "@kalcode/ui/components";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Globe,
  LayoutGrid,
  Plus,
  Server,
  Sparkles,
  SquareTerminal,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import {
  emptyRecipe,
  MAX_RECIPE_COMPONENTS,
  MAX_RECIPE_VARIABLES,
  providerName,
  RECIPE_LAYOUTS,
  VARIABLE_KEY,
} from "../../runtime/recipes/model.ts";
import { resolveRecipeDefaultAccount, useRecipeLibrary } from "../../runtime/recipes/RecipeLaunchProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { WIDGETS } from "../../shell/widgets/registry.tsx";
import {
  effortLabel,
  effortsForModel,
  modelCatalogCanVerifyCapabilities,
  modelEffortsAreKnown,
  readLaunchMemory,
} from "../code/panes/agentLaunch.ts";
import { isPaneProvider } from "../code/panes/paneChannel.ts";
import { useOptionalProviderAccountSessions } from "../providers/ProviderAccountSessions.tsx";
import styles from "./RecipeEditor.module.css";

const PROVIDERS = ["claude-code", "codex", "cursor", "gemini-cli"] as const;
const KINDS = [
  { kind: "agent", label: "Agent", icon: Bot },
  { kind: "terminal", label: "Terminal", icon: SquareTerminal },
  { kind: "browser", label: "Browser", icon: Globe },
  { kind: "service", label: "Service", icon: Server },
  { kind: "widget", label: "Widget", icon: LayoutGrid },
  { kind: "squad", label: "Squad", icon: UsersRound },
] as const;

type Kind = RecipeComponent["kind"];

function nextKey(kind: Kind, components: readonly RecipeComponent[]): string {
  const taken = new Set(components.map((part) => part.key));
  for (let n = 1; ; n += 1) if (!taken.has(`${kind}-${n}`)) return `${kind}-${n}`;
}

function blankPart(kind: Kind, key: string): RecipeComponent {
  switch (kind) {
    case "agent":
      return {
        kind,
        key,
        providerId: "claude-code",
        providerAccountId: null,
        model: null,
        effort: null,
        name: null,
        task: null,
      };
    case "terminal":
      return { kind, key, name: null, command: null };
    case "browser":
      return { kind, key, url: "" };
    case "service":
      return { kind, key, name: "", command: "" };
    case "widget":
      return { kind, key, widget: WIDGETS[0]?.id ?? "" };
    case "squad":
      return { kind, key, squadId: "", goal: null };
  }
}

const orNull = (value: string) => (value.trim() === "" ? null : value);

/** What blocks saving, as plain sentences; native validation still has the last word. */
export function validateRecipe(recipe: LaunchRecipe): string[] {
  const problems: string[] = [];
  if (!recipe.name.trim()) problems.push("Give the Recipe a name.");
  if (recipe.components.length > MAX_RECIPE_COMPONENTS)
    problems.push(`A Recipe holds at most ${MAX_RECIPE_COMPONENTS} parts.`);
  if (recipe.variables.length > MAX_RECIPE_VARIABLES)
    problems.push(`A Recipe holds at most ${MAX_RECIPE_VARIABLES} variables.`);
  const seen = new Set<string>();
  for (const variable of recipe.variables) {
    if (!VARIABLE_KEY.test(variable.key))
      problems.push(`Variable "${variable.key}" must start with a letter and use a-z, 0-9 or _ (32 max).`);
    else if (seen.has(variable.key)) problems.push(`Variable "${variable.key}" is used twice.`);
    seen.add(variable.key);
  }
  for (const part of recipe.components) {
    if (part.kind === "browser" && !part.url.trim()) problems.push("A Browser part needs an address.");
    if (part.kind === "service" && (!part.name.trim() || !part.command.trim()))
      problems.push("A Service needs a name and a command.");
    if (part.kind === "squad" && !part.squadId) problems.push("Choose a Squad for the Squad part.");
    if (part.kind === "widget" && !part.widget) problems.push("Choose a widget.");
  }
  return problems;
}

export function RecipeEditor() {
  const library = useRecipeLibrary();
  const { isOpen, recipe, close } = library.editor;
  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.sheet} aria-describedby={undefined}>
          {isOpen ? <EditorForm initial={recipe} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EditorForm({ initial }: { initial: LaunchRecipe | null }) {
  const library = useRecipeLibrary();
  const { client } = useRuntime();
  const providerSessions = useOptionalProviderAccountSessions();
  const { active } = useWorkspaces();
  const workspaces = useWorkspaces();
  const uid = useId();
  const creating = initial === null;
  const [draft, setDraft] = useState<LaunchRecipe>(() =>
    initial ? structuredClone(initial) : emptyRecipe(crypto.randomUUID(), active?.id ?? null, library.recipes.length),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [squads, setSquads] = useState<SquadDefinition[]>([]);
  const [accounts, setAccounts] = useState<Record<string, ProviderAccount[]>>({});
  const [bindings, setBindings] = useState<ProviderAccountBinding[] | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [bindingRequest, setBindingRequest] = useState(0);
  const launchMemory = useMemo(() => readLaunchMemory(), []);

  useEffect(() => {
    let live = true;
    client.squads
      .snapshot()
      .then((snapshot) => live && setSquads(snapshot.squads))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bindingRequest is the explicit retry signal.
  useEffect(() => {
    let live = true;
    setBindings(null);
    setBindingError(null);
    client
      .listProviderAccountBindings()
      .then((list) => {
        if (!live) return;
        setBindings(list);
      })
      .catch(() => {
        if (!live) return;
        setBindings(null);
        setBindingError("Default account couldn't be resolved because project account choices are unavailable.");
      });
    return () => {
      live = false;
    };
  }, [bindingRequest, client]);

  const providersUsed = [...new Set(draft.components.flatMap((p) => (p.kind === "agent" ? [p.providerId] : [])))];
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const providerKey = providersUsed.join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: providerKey stands for providersUsed
  useEffect(() => {
    for (const providerId of providersUsed) {
      if (requested.current.has(providerId)) continue;
      requested.current.add(providerId);
      client
        .listProviderAccounts(providerId)
        .then((list) => list.filter((a) => !a.archivedAt))
        .catch(() => [] as ProviderAccount[])
        .then((list) => mounted.current && setAccounts((current) => ({ ...current, [providerId]: list })));
    }
  }, [client, providerKey]);

  const fallbackAccounts = useMemo(() => Object.values(accounts).flat(), [accounts]);
  const availableAccounts = providerSessions?.accounts ?? fallbackAccounts;
  const targetWorkspaceId = draft.workspaceId ?? active?.id ?? null;
  const effectiveAccounts = useMemo(() => {
    const resolved = new Map<string, ProviderAccount>();
    for (const part of draft.components) {
      if (part.kind !== "agent") continue;
      const explicit = part.providerAccountId
        ? availableAccounts.find(
            (account) =>
              account.id === part.providerAccountId &&
              account.providerId === part.providerId &&
              account.archivedAt === null,
          )
        : null;
      const account = part.providerAccountId
        ? explicit
        : bindings !== null
          ? resolveRecipeDefaultAccount(availableAccounts, bindings, launchMemory, part.providerId, targetWorkspaceId)
          : null;
      if (account) resolved.set(part.key, account);
    }
    return resolved;
  }, [availableAccounts, bindings, draft.components, launchMemory, targetWorkspaceId]);
  const discoveryAccountIds = useMemo(
    () => [...new Set([...effectiveAccounts.values()].map((account) => account.id))].sort(),
    [effectiveAccounts],
  );
  const discoveryKey = JSON.stringify(discoveryAccountIds);
  const discoverModels = providerSessions?.discoverModels;
  useEffect(() => {
    if (!discoverModels) return;
    for (const accountId of JSON.parse(discoveryKey) as string[]) void discoverModels(accountId);
  }, [discoverModels, discoveryKey]);

  const agentCapabilities = new Map<
    string,
    { efforts: readonly string[]; unavailableEffort: boolean; modelId: string | null }
  >();
  for (const part of draft.components) {
    if (part.kind !== "agent" || !isPaneProvider(part.providerId)) continue;
    const account = effectiveAccounts.get(part.key);
    const catalog = account ? (providerSessions?.states.get(account.id)?.models ?? null) : null;
    const model = part.model
      ? (catalog?.items.find((candidate) => candidate.id === part.model) ?? null)
      : (catalog?.items.find((candidate) => candidate.isDefault) ?? null);
    const efforts = effortsForModel(part.providerId, model, catalog?.supportedEfforts);
    const unavailableEffort = Boolean(
      part.effort &&
        catalog &&
        modelCatalogCanVerifyCapabilities(catalog) &&
        (!part.model || model !== null) &&
        modelEffortsAreKnown(model, catalog.supportedEfforts) &&
        !efforts.includes(part.effort),
    );
    agentCapabilities.set(part.key, {
      efforts,
      unavailableEffort,
      modelId: part.model ?? model?.id ?? null,
    });
  }

  const patch = (partial: Partial<LaunchRecipe>) => {
    setError(null);
    setDraft((current) => ({ ...current, ...partial }));
  };
  const setPart = (key: string, change: Partial<RecipeComponent>) =>
    patch({
      components: draft.components.map((part) =>
        part.key === key ? ({ ...part, ...change } as RecipeComponent) : part,
      ),
    });
  const movePart = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draft.components.length) return;
    const next = [...draft.components];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved as RecipeComponent);
    patch({ components: next });
  };
  const setVariable = (index: number, change: Partial<RecipeVariable>) =>
    patch({ variables: draft.variables.map((v, i) => (i === index ? { ...v, ...change } : v)) });

  const problems = [
    ...validateRecipe(draft),
    ...draft.components.flatMap((part) => {
      if (part.kind !== "agent" || !part.effort) return [];
      const capability = agentCapabilities.get(part.key);
      if (!capability?.unavailableEffort) return [];
      const model = capability.modelId ? ` for model "${capability.modelId}"` : "";
      return [
        `${providerName(part.providerId)} no longer reports effort "${part.effort}"${model}. Choose a reported effort or Provider default.`,
      ];
    }),
  ];
  const save = async () => {
    if (problems.length > 0) {
      setError(problems[0] ?? null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await library.save({ ...draft, name: draft.name.trim() });
      library.editor.close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const id = (name: string) => `${uid}-${name}`;
  const tooMany = draft.components.length >= MAX_RECIPE_COMPONENTS;

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className={styles.header}>
        <div className={styles.headline}>
          <span className={styles.eyebrow}>{creating ? "New Recipe" : "Edit Recipe"}</span>
          <Dialog.Title className={styles.title}>{draft.name.trim() || "Untitled desk"}</Dialog.Title>
        </div>
        <Dialog.Close asChild>
          <IconButton label="Close editor" icon={<X />} size="sm" />
        </Dialog.Close>
      </header>

      <div className={styles.scroll}>
        <section className={styles.basics} aria-label="Recipe basics">
          <Field htmlFor={id("name")} label="Name">
            <TextInput
              id={id("name")}
              value={draft.name}
              maxLength={120}
              placeholder="Release desk"
              autoFocus
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>
          <Field htmlFor={id("project")} label="Project">
            <Select
              id={id("project")}
              value={draft.workspaceId ?? ""}
              onChange={(event) => patch({ workspaceId: event.target.value || null })}
            >
              <option value="">Any project</option>
              {active ? <option value={active.id}>{active.name} (current)</option> : null}
              {workspaces.workspaces
                .filter((w) => w.id !== active?.id)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              {draft.workspaceId && !workspaces.workspaces.some((w) => w.id === draft.workspaceId) ? (
                <option value={draft.workspaceId}>Missing project</option>
              ) : null}
            </Select>
          </Field>
          <Field htmlFor={id("layout")} label="Layout">
            <Select
              id={id("layout")}
              value={draft.layout ?? ""}
              onChange={(event) => patch({ layout: event.target.value || null })}
            >
              <option value="">None</option>
              {RECIPE_LAYOUTS.map((layout) => (
                <option key={layout} value={layout}>
                  {layout[0]?.toUpperCase()}
                  {layout.slice(1)} panes
                </option>
              ))}
            </Select>
          </Field>
        </section>

        <section className={styles.section} aria-labelledby={id("parts")}>
          <div className={styles.sectionHead}>
            <h3 id={id("parts")} className={styles.sectionTitle}>
              Parts <span className={styles.count}>{draft.components.length}</span>
            </h3>
            <div className={styles.adders} role="toolbar" aria-label="Add a part">
              {KINDS.map(({ kind, label, icon: Icon }) => (
                <Button
                  key={kind}
                  size="sm"
                  variant="ghost"
                  icon={<Icon />}
                  disabled={tooMany}
                  aria-label={`Add ${label}`}
                  onClick={() =>
                    patch({ components: [...draft.components, blankPart(kind, nextKey(kind, draft.components))] })
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          {draft.components.length === 0 ? (
            <p className={styles.hintLine}>Add the agents, terminals, browser tabs and services this desk needs.</p>
          ) : (
            <ol className={styles.parts}>
              {draft.components.map((part, index) => {
                const meta = KINDS.find((k) => k.kind === part.kind);
                const Icon = meta?.icon ?? Sparkles;
                const effortCapability = agentCapabilities.get(part.key);
                const reportedEfforts = effortCapability?.efforts ?? [];
                const offeredEfforts =
                  part.kind === "agent" && part.effort && !reportedEfforts.includes(part.effort)
                    ? [...reportedEfforts, part.effort]
                    : reportedEfforts;
                return (
                  <li key={part.key} className={styles.part} data-kind={part.kind}>
                    <div className={styles.partHead}>
                      <span className={styles.partIcon} aria-hidden="true">
                        {part.kind === "agent" ? <ProviderGlyph provider={part.providerId} size="sm" /> : <Icon />}
                      </span>
                      <span className={styles.partTitle}>
                        {meta?.label} <code className={styles.key}>{part.key}</code>
                      </span>
                      <span className={styles.partTools}>
                        <IconButton
                          size="sm"
                          label={`Move ${part.key} up`}
                          icon={<ArrowUp />}
                          disabled={index === 0}
                          onClick={() => movePart(index, -1)}
                        />
                        <IconButton
                          size="sm"
                          label={`Move ${part.key} down`}
                          icon={<ArrowDown />}
                          disabled={index === draft.components.length - 1}
                          onClick={() => movePart(index, 1)}
                        />
                        <IconButton
                          size="sm"
                          label={`Remove ${part.key}`}
                          icon={<Trash2 />}
                          onClick={() => patch({ components: draft.components.filter((p) => p.key !== part.key) })}
                        />
                      </span>
                    </div>
                    <div className={styles.partFields}>
                      {part.kind === "agent" ? (
                        <>
                          <PartField id={id(`${part.key}-provider`)} label="Provider">
                            <Select
                              id={id(`${part.key}-provider`)}
                              value={part.providerId}
                              onChange={(event) =>
                                setPart(part.key, {
                                  providerId: event.target.value,
                                  // Account, model and effort belong to one provider.
                                  providerAccountId: null,
                                  model: null,
                                  effort: null,
                                })
                              }
                            >
                              {PROVIDERS.map((p) => (
                                <option key={p} value={p}>
                                  {providerName(p)}
                                </option>
                              ))}
                            </Select>
                          </PartField>
                          <PartField id={id(`${part.key}-account`)} label="Account">
                            <Select
                              id={id(`${part.key}-account`)}
                              value={part.providerAccountId ?? ""}
                              onChange={(event) => setPart(part.key, { providerAccountId: event.target.value || null })}
                            >
                              <option value="">Default account</option>
                              {(accounts[part.providerId] ?? []).map((account) => (
                                <option key={account.id} value={account.id}>
                                  {account.displayName}
                                </option>
                              ))}
                            </Select>
                            {!part.providerAccountId && bindingError ? (
                              <p className={styles.error} role="alert">
                                {bindingError}{" "}
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setBindingRequest((request) => request + 1)}
                                >
                                  Retry account choices
                                </Button>
                              </p>
                            ) : null}
                          </PartField>
                          <PartField id={id(`${part.key}-model`)} label="Model" optional>
                            <TextInput
                              id={id(`${part.key}-model`)}
                              value={part.model ?? ""}
                              placeholder="Exact model id"
                              onChange={(event) => setPart(part.key, { model: orNull(event.target.value) })}
                            />
                          </PartField>
                          <PartField id={id(`${part.key}-effort`)} label="Effort" optional>
                            <Select
                              id={id(`${part.key}-effort`)}
                              value={part.effort ?? ""}
                              onChange={(event) => setPart(part.key, { effort: event.target.value || null })}
                            >
                              <option value="">Provider default</option>
                              {offeredEfforts.map((effort) => (
                                <option key={effort} value={effort}>
                                  {effortCapability?.unavailableEffort && effort === part.effort
                                    ? `Unavailable · ${effortLabel(effort)}`
                                    : effortLabel(effort)}
                                </option>
                              ))}
                            </Select>
                          </PartField>
                          <PartField id={id(`${part.key}-name`)} label="Name" optional>
                            <TextInput
                              id={id(`${part.key}-name`)}
                              value={part.name ?? ""}
                              onChange={(event) => setPart(part.key, { name: orNull(event.target.value) })}
                            />
                          </PartField>
                          <PartField id={id(`${part.key}-task`)} label="First task" optional wide>
                            <TextArea
                              id={id(`${part.key}-task`)}
                              rows={2}
                              value={part.task ?? ""}
                              placeholder="Sent once the agent is ready. Use {{variables}}."
                              onChange={(event) => setPart(part.key, { task: orNull(event.target.value) })}
                            />
                          </PartField>
                        </>
                      ) : null}
                      {part.kind === "terminal" ? (
                        <>
                          <PartField id={id(`${part.key}-name`)} label="Name" optional>
                            <TextInput
                              id={id(`${part.key}-name`)}
                              value={part.name ?? ""}
                              onChange={(event) => setPart(part.key, { name: orNull(event.target.value) })}
                            />
                          </PartField>
                          <PartField id={id(`${part.key}-command`)} label="Startup command" optional>
                            <TextInput
                              id={id(`${part.key}-command`)}
                              value={part.command ?? ""}
                              onChange={(event) => setPart(part.key, { command: orNull(event.target.value) })}
                            />
                          </PartField>
                        </>
                      ) : null}
                      {part.kind === "browser" ? (
                        <PartField id={id(`${part.key}-url`)} label="Address" wide>
                          <TextInput
                            id={id(`${part.key}-url`)}
                            value={part.url}
                            placeholder="http://localhost:3000"
                            onChange={(event) => setPart(part.key, { url: event.target.value })}
                          />
                        </PartField>
                      ) : null}
                      {part.kind === "service" ? (
                        <>
                          <PartField id={id(`${part.key}-name`)} label="Name">
                            <TextInput
                              id={id(`${part.key}-name`)}
                              value={part.name}
                              onChange={(event) => setPart(part.key, { name: event.target.value })}
                            />
                          </PartField>
                          <PartField id={id(`${part.key}-command`)} label="Command">
                            <TextInput
                              id={id(`${part.key}-command`)}
                              value={part.command}
                              onChange={(event) => setPart(part.key, { command: event.target.value })}
                            />
                          </PartField>
                        </>
                      ) : null}
                      {part.kind === "widget" ? (
                        <PartField id={id(`${part.key}-widget`)} label="Widget" wide>
                          <Select
                            id={id(`${part.key}-widget`)}
                            value={part.widget}
                            onChange={(event) => setPart(part.key, { widget: event.target.value })}
                          >
                            {WIDGETS.map((widget) => (
                              <option key={widget.id} value={widget.id}>
                                {widget.title}
                              </option>
                            ))}
                          </Select>
                        </PartField>
                      ) : null}
                      {part.kind === "squad" ? (
                        <>
                          <PartField id={id(`${part.key}-squad`)} label="Squad">
                            <Select
                              id={id(`${part.key}-squad`)}
                              value={part.squadId}
                              onChange={(event) => setPart(part.key, { squadId: event.target.value })}
                            >
                              <option value="">Choose a Squad</option>
                              {squads.map((squad) => (
                                <option key={squad.id} value={squad.id}>
                                  {squad.name}
                                </option>
                              ))}
                              {part.squadId && !squads.some((s) => s.id === part.squadId) ? (
                                <option value={part.squadId}>Missing Squad</option>
                              ) : null}
                            </Select>
                          </PartField>
                          <PartField id={id(`${part.key}-goal`)} label="Goal" optional>
                            <TextInput
                              id={id(`${part.key}-goal`)}
                              value={part.goal ?? ""}
                              onChange={(event) => setPart(part.key, { goal: orNull(event.target.value) })}
                            />
                          </PartField>
                        </>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className={styles.section} aria-labelledby={id("vars")}>
          <div className={styles.sectionHead}>
            <h3 id={id("vars")} className={styles.sectionTitle}>
              Variables <span className={styles.count}>{draft.variables.length}</span>
            </h3>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus />}
              disabled={draft.variables.length >= MAX_RECIPE_VARIABLES}
              onClick={() =>
                patch({
                  variables: [...draft.variables, { key: "", label: "", defaultValue: "", askAtLaunch: false }],
                })
              }
            >
              Add variable
            </Button>
          </div>
          {draft.variables.length === 0 ? (
            <p className={styles.hintLine}>
              Use <code className={styles.key}>{"{{branch}}"}</code> in names, commands, addresses and tasks, then fill
              it in at launch.
            </p>
          ) : (
            <ul className={styles.variables}>
              {draft.variables.map((variable, index) => {
                const invalid = variable.key !== "" && !VARIABLE_KEY.test(variable.key);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: variables have no stable id until saved
                  <li key={index} className={styles.variable}>
                    <TextInput
                      aria-label={`Variable ${index + 1} key`}
                      aria-invalid={invalid || undefined}
                      value={variable.key}
                      placeholder="branch"
                      onChange={(event) => setVariable(index, { key: event.target.value })}
                    />
                    <TextInput
                      aria-label={`Variable ${index + 1} label`}
                      value={variable.label}
                      placeholder="Label"
                      onChange={(event) => setVariable(index, { label: event.target.value })}
                    />
                    <TextInput
                      aria-label={`Variable ${index + 1} default`}
                      value={variable.defaultValue}
                      placeholder="Default"
                      onChange={(event) => setVariable(index, { defaultValue: event.target.value })}
                    />
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        checked={variable.askAtLaunch}
                        onChange={(event) => setVariable(index, { askAtLaunch: event.target.checked })}
                      />
                      Ask at launch
                    </label>
                    <IconButton
                      size="sm"
                      label={`Remove variable ${variable.key || index + 1}`}
                      icon={<Trash2 />}
                      onClick={() => patch({ variables: draft.variables.filter((_, i) => i !== index) })}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <footer className={styles.footer}>
        <p className={styles.error} role="alert" aria-live="assertive">
          {error}
        </p>
        <Button variant="ghost" onClick={() => library.editor.close()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={saving}>
          {creating ? "Save Recipe" : "Save changes"}
        </Button>
      </footer>
    </form>
  );
}

function PartField({
  id,
  label,
  optional,
  wide,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Field htmlFor={id} label={label} optional={optional} className={wide ? styles.wide : undefined}>
      {children}
    </Field>
  );
}
