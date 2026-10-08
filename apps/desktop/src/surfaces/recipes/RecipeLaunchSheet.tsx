import { Button, Field, ProviderGlyph, Select, TextInput } from "@kalcode/ui/components";
import { Bot, Globe, LayoutGrid, Play, Server, SquareTerminal, TriangleAlert, UsersRound } from "lucide-react";
import { Dialog } from "radix-ui";
import { type ReactNode, useId, useRef, useState } from "react";
import type { RecipeBlocker, RecipeLaunchInputs, RecipePreflight } from "../../runtime/recipes/model.ts";
import { providerName } from "../../runtime/recipes/model.ts";
import { useRecipeLaunch } from "../../runtime/recipes/RecipeLaunchProvider.tsx";
import { LaunchSignIn } from "../providers/LaunchAccountPicker.tsx";
import styles from "./RecipeLaunchSheet.module.css";

const REPAIR_LABEL = {
  reconnect: "Reconnect",
  "choose-account": "Choose account",
  "open-project": "Open project",
  edit: "Edit Recipe",
} as const;

const PLAN_ICON = {
  agent: Bot,
  terminal: SquareTerminal,
  browser: Globe,
  service: Server,
  widget: LayoutGrid,
  squad: UsersRound,
} as const;

export function RecipeLaunchSheet() {
  const launch = useRecipeLaunch();
  const { phase } = launch;
  const open = phase.kind === "preparing" || phase.kind === "review" || phase.kind === "launching";
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && phase.kind === "review" && launch.cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.sheet}
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => phase.kind !== "review" && event.preventDefault()}
          onInteractOutside={(event) => phase.kind !== "review" && event.preventDefault()}
        >
          {phase.kind === "preparing" ? (
            <div className={styles.busy} role="status">
              <span className={styles.spinner} aria-hidden="true" />
              <Dialog.Title className={styles.busyTitle}>Preparing {phase.recipeName}</Dialog.Title>
            </div>
          ) : null}
          {phase.kind === "launching" ? (
            <Progress preflight={phase.preflight} done={phase.done} total={phase.total} />
          ) : null}
          {phase.kind === "review" ? <Review preflight={phase.preflight} inputs={phase.inputs} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Progress({ preflight, done, total }: { preflight: RecipePreflight; done: number; total: number }) {
  const launch = useRecipeLaunch();
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className={styles.progress}>
      <Dialog.Title className={styles.title}>Launching {preflight.recipe.name}</Dialog.Title>
      <p className={styles.sub} role="status">
        {done} of {total} started
      </p>
      <div
        className={styles.track}
        role="progressbar"
        aria-label="Launch progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <span className={styles.fill} style={{ width: `${percent}%` }} />
      </div>
      <div className={styles.progressActions}>
        <Button size="sm" variant="ghost" onClick={() => launch.cancel()}>
          Cancel launch
        </Button>
      </div>
    </div>
  );
}

function Review({ preflight, inputs }: { preflight: RecipePreflight; inputs: RecipeLaunchInputs }) {
  const launch = useRecipeLaunch();
  const uid = useId();
  const [launching, setLaunching] = useState(false);
  const skip = inputs.skip ?? [];
  // A skipped part drops out of preflight, so remember its blocker to keep the toggle reversible.
  const seen = useRef(new Map<string, RecipeBlocker>());
  const recipeId = useRef(preflight.recipe.id);
  if (recipeId.current !== preflight.recipe.id) {
    recipeId.current = preflight.recipe.id;
    seen.current.clear();
  }
  for (const blocker of preflight.blockers) if (blocker.componentKey) seen.current.set(blocker.componentKey, blocker);
  const skipped = skip.flatMap((key) => {
    const blocker = seen.current.get(key);
    return blocker && !preflight.blockers.includes(blocker) ? [blocker] : [];
  });
  const rows = [...preflight.blockers, ...skipped];
  const hardBlocked = preflight.blockers.some((blocker) => !blocker.skippable);
  // Blocked parts that are neither fixed nor skipped don't start; say so before Launch.
  const unresolved = preflight.blockers.filter((blocker) => blocker.skippable).length;

  const toggleSkip = (key: string, on: boolean) =>
    launch.update({ ...inputs, skip: on ? [...new Set([...skip, key])] : skip.filter((k) => k !== key) });

  return (
    <form
      className={styles.review}
      onSubmit={(event) => {
        event.preventDefault();
        if (hardBlocked || launching) return;
        setLaunching(true);
        void launch.confirm().finally(() => setLaunching(false));
      }}
    >
      <header className={styles.header}>
        <span className={styles.eyebrow}>Launch Recipe</span>
        <Dialog.Title className={styles.title}>{preflight.recipe.name}</Dialog.Title>
        <p className={styles.sub}>
          {preflight.workspace ? `In ${preflight.workspace.name}` : "No project selected"}
          {preflight.layout ? ` · ${preflight.layout} panes` : ""}
        </p>
      </header>

      <div className={styles.scroll}>
        {preflight.ask.length > 0 ? (
          <section className={styles.group} aria-label="Fill in before launch">
            {preflight.ask.map((variable) => (
              <Field key={variable.key} htmlFor={`${uid}-${variable.key}`} label={variable.label || variable.key}>
                <TextInput
                  id={`${uid}-${variable.key}`}
                  value={inputs.values?.[variable.key] ?? preflight.values[variable.key] ?? ""}
                  onChange={(event) =>
                    launch.update({
                      ...inputs,
                      values: { ...preflight.values, ...inputs.values, [variable.key]: event.target.value },
                    })
                  }
                />
              </Field>
            ))}
          </section>
        ) : null}

        {rows.length > 0 ? (
          <section className={styles.group} aria-label="Needs attention">
            <ul className={styles.blockers}>
              {rows.map((blocker) => {
                const key = blocker.componentKey;
                const isSkipped = key !== null && skip.includes(key);
                return (
                  <li
                    key={`${key ?? "recipe"}-${blocker.title}`}
                    className={styles.blocker}
                    data-skipped={isSkipped || undefined}
                  >
                    <TriangleAlert className={styles.blockerIcon} aria-hidden="true" />
                    <div className={styles.blockerBody}>
                      <strong className={styles.blockerTitle}>{blocker.title}</strong>
                      <p className={styles.blockerDetail}>{blocker.detail}</p>
                      {!isSkipped ? (
                        <div className={styles.blockerActions}>
                          {blocker.repair.kind === "choose-account" && key ? (
                            <AccountChoice
                              providerId={blocker.repair.providerId}
                              label={blocker.title}
                              value={inputs.accounts?.[key] ?? ""}
                              onChange={(accountId) =>
                                launch.update({ ...inputs, accounts: { ...inputs.accounts, [key]: accountId } })
                              }
                            />
                          ) : null}
                          {blocker.repair.kind === "reconnect" || blocker.repair.kind === "choose-account" ? (
                            <LaunchSignIn
                              providerId={blocker.repair.providerId}
                              providerName={providerName(blocker.repair.providerId)}
                              account={
                                blocker.repair.kind === "reconnect"
                                  ? launch.accounts.find(
                                      (a) => a.id === (blocker.repair as { accountId: string }).accountId,
                                    )
                                  : undefined
                              }
                              needed
                              reconnect={blocker.repair.kind === "reconnect"}
                              disabled={false}
                              onReload={launch.refreshEnvironment}
                              onBusyChange={() => undefined}
                              onConnected={async () => {
                                await launch.refreshEnvironment();
                              }}
                            />
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => launch.repair(blocker)}>
                              {REPAIR_LABEL[blocker.repair.kind]}
                            </Button>
                          )}
                        </div>
                      ) : null}
                    </div>
                    {blocker.skippable && key ? (
                      <label className={styles.skip}>
                        <input
                          type="checkbox"
                          checked={isSkipped}
                          onChange={(event) => toggleSkip(key, event.target.checked)}
                          aria-label={`Skip ${blocker.title}`}
                        />
                        Skip
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {preflight.consequences.length > 0 ? (
          <ul className={styles.consequences} aria-label="What this launch does">
            {preflight.consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        <section aria-label="Plan">
          <h3 className={styles.planTitle}>
            Plan <span className={styles.count}>{preflight.plan.length}</span>
          </h3>
          {preflight.plan.length === 0 ? (
            <p className={styles.empty}>Nothing will start yet.</p>
          ) : (
            <ol className={styles.plan}>
              {preflight.plan.map((part) => {
                const Icon = PLAN_ICON[part.kind];
                const glyph: ReactNode =
                  part.kind === "agent" ? <ProviderGlyph provider={part.providerId} size="xs" /> : <Icon />;
                return (
                  <li key={part.key} className={styles.planItem}>
                    <span className={styles.planIcon} aria-hidden="true">
                      {glyph}
                    </span>
                    <span className={styles.planLabel}>{part.label}</span>
                    <span className={styles.planKind}>{part.kind}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>

      <footer className={styles.footer}>
        {hardBlocked ? (
          <span className={styles.footNote}>Resolve what needs attention to launch.</span>
        ) : unresolved > 0 ? (
          <span className={styles.footNote}>
            {unresolved === 1 ? "1 blocked part will be skipped." : `${unresolved} blocked parts will be skipped.`}
          </span>
        ) : (
          <span />
        )}
        <Button variant="ghost" onClick={() => launch.cancel()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" icon={<Play />} disabled={hardBlocked} busy={launching}>
          Launch
        </Button>
      </footer>
    </form>
  );
}

function AccountChoice({
  providerId,
  label,
  value,
  onChange,
}: {
  providerId: string;
  label: string;
  value: string;
  onChange(accountId: string): void;
}) {
  const launch = useRecipeLaunch();
  const accounts = launch.accounts.filter((a) => a.providerId === providerId && !a.archivedAt);
  return (
    <Select
      className={styles.accountSelect}
      aria-label={`Account for ${label}`}
      value={value}
      onChange={(event) => event.target.value && onChange(event.target.value)}
    >
      <option value="">Choose an account</option>
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.displayName}
        </option>
      ))}
    </Select>
  );
}
