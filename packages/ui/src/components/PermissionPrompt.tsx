import { ShieldAlert, ShieldCheck, ShieldX, TimerOff } from "lucide-react";
import type { ReactNode } from "react";
import { Button, type ButtonVariant } from "./Button.tsx";
import { cx } from "./cx.ts";
import styles from "./PermissionPrompt.module.css";

export type PermissionPromptStatus = "pending" | "approved" | "denied" | "expired";
export type PermissionScopeTone = "neutral" | "waiting" | "danger";

export interface PermissionPromptScope {
  id: string;
  label: string;
  tone?: PermissionScopeTone;
}

export interface PermissionPromptOption<T extends string = string> {
  value: T;
  label: string;
  /** What choosing this covers, shown under the buttons ("Covers changing any file…"). */
  description?: string;
  variant?: ButtonVariant;
}

export interface PermissionPromptContext {
  provider: string;
  thread: string;
  workspace: string;
  mode: string;
  /** Highlights the mode (Bypass). */
  modeTone?: "neutral" | "danger";
}

export interface PermissionPromptProps<T extends string = string> {
  /** Stable id used for ARIA wiring (e.g. the request id). */
  id: string;
  /** One line: what the agent wants to do ("Run npm install lodash"). */
  title: string;
  /** The exact command, path or address, shown verbatim in monospace. */
  detail?: string;
  /** Why KalCode is asking (the policy's reason). */
  reason: string;
  context: PermissionPromptContext;
  scopes: readonly PermissionPromptScope[];
  options: readonly PermissionPromptOption<T>[];
  onDecide: (value: T) => void;
  /** The option being submitted; every button is disabled meanwhile. */
  busy?: T | null;
  status?: PermissionPromptStatus;
  /** Shown for resolved requests ("Approved once", "Expired: the thread stopped"). */
  statusText?: string;
  /** Relative time label ("just now"). */
  requestedAt?: string;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

const STATUS_ICONS = {
  pending: ShieldAlert,
  approved: ShieldCheck,
  denied: ShieldX,
  expired: TimerOff,
} as const;

/**
 * An approval request an agent is waiting on. Built to be impossible to miss and safe to
 * answer: the exact action is shown verbatim, Deny comes first, no option is pre-focused or
 * bound to a single key, and resolved requests become read-only.
 */
export function PermissionPrompt<T extends string>({
  id,
  title,
  detail,
  reason,
  context,
  scopes,
  options,
  onDecide,
  busy = null,
  status = "pending",
  statusText,
  requestedAt,
  headingLevel = 3,
  className,
}: PermissionPromptProps<T>) {
  const Heading = `h${headingLevel}` as const;
  const Icon = STATUS_ICONS[status];
  const titleId = `permission-${id}-title`;
  const reasonId = `permission-${id}-reason`;
  const pending = status === "pending";
  const described = options.filter((option) => option.description);

  return (
    <section
      className={cx(styles.prompt, className)}
      data-status={status}
      aria-labelledby={titleId}
      aria-describedby={reasonId}
    >
      <span className={styles.rail} aria-hidden="true" />
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <Icon />
        </span>
        <div className={styles.heading}>
          <p className={styles.eyebrow}>
            {pending ? "Approval needed" : (statusText ?? status)}
            {requestedAt ? <span className={styles.time}> · {requestedAt}</span> : null}
          </p>
          <Heading id={titleId} className={styles.title}>
            {title}
          </Heading>
        </div>
      </header>

      {detail ? (
        <pre className={styles.detail} data-selectable>
          <code>{detail}</code>
        </pre>
      ) : null}

      <p id={reasonId} className={styles.reason}>
        {reason}
      </p>

      {scopes.length > 0 ? (
        <ul className={styles.scopes} aria-label="Permissions this needs">
          {scopes.map((scope) => (
            <li key={scope.id} className={styles.scope} data-tone={scope.tone ?? "neutral"}>
              {scope.label}
            </li>
          ))}
        </ul>
      ) : null}

      <dl className={styles.context}>
        <ContextItem label="Provider">{context.provider}</ContextItem>
        <ContextItem label="Thread">{context.thread}</ContextItem>
        <ContextItem label="Workspace">{context.workspace}</ContextItem>
        <ContextItem label="Mode">
          <span data-tone={context.modeTone ?? "neutral"} className={styles.mode}>
            {context.mode}
          </span>
        </ContextItem>
      </dl>

      {pending ? (
        <>
          <fieldset className={styles.actions}>
            <legend className="visually-hidden">Answer: {title}</legend>
            {options.map((option) => (
              <Button
                key={option.value}
                variant={option.variant ?? "secondary"}
                busy={busy === option.value}
                disabled={busy !== null && busy !== option.value}
                onClick={() => onDecide(option.value)}
                aria-describedby={option.description ? `permission-${id}-${option.value}` : undefined}
              >
                {option.label}
              </Button>
            ))}
          </fieldset>
          {described.length > 0 ? (
            <ul className={styles.coverage}>
              {described.map((option) => (
                <li key={option.value} id={`permission-${id}-${option.value}`}>
                  <strong>{option.label}:</strong> {option.description}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ContextItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.contextItem}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
