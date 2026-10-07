import { ProviderGlyph, Select } from "@kalcode/ui/components";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { effortLabel } from "../code/panes/agentLaunch.ts";
import { accountName } from "../providers/accountIdentity.ts";
import type { DraftRoute } from "./model.ts";
import styles from "./RoutePicker.module.css";
import { type RouteOptions, routeEffort, routeEfforts, routeModel, routeSummary } from "./routeOptions.ts";

export interface RoutePickerProps {
  route: DraftRoute;
  onChange: (route: DraftRoute) => void;
  options: RouteOptions;
  /** Accessible name of the choices ("Review agent"). */
  label: string;
  disabled?: boolean;
  /** Start expanded (reroute and retry panels, where the choice is the point). */
  defaultOpen?: boolean;
  invalid?: boolean;
}

/**
 * One step's provider, account, exact model and effort. Collapsed it is one quiet line that says
 * what will run (the remembered configuration, so most steps need no choice); expanded it offers
 * the same choices as New agent, from the same account and model sources.
 */
export function RoutePicker({
  route,
  onChange,
  options,
  label,
  disabled,
  defaultOpen = false,
  invalid,
}: RoutePickerProps) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const { discover } = options;
  useEffect(() => {
    if (route.providerAccountId) discover(route.providerAccountId);
  }, [discover, route.providerAccountId]);

  const models = options.models(route.providerId, route.providerAccountId);
  const model = routeModel(route, models);
  const defaultModel = (models.items ?? []).find((m) => m.isDefault) ?? models.items?.[0] ?? null;
  const efforts = routeEfforts(route, models);
  const effectiveEffort = models.items ? routeEffort(route, models) : "";
  const summary = routeSummary(route, options);
  const choice = route.providerAccountId ? `${route.providerId}\u0000${route.providerAccountId}` : "";
  const known = options.groups.some((g) => g.accounts.some((a) => `${g.providerId}\u0000${a.id}` === choice));

  return (
    <div className={styles.picker} data-open={open || undefined} data-invalid={invalid || undefined}>
      <button
        type="button"
        className={styles.summary}
        aria-expanded={open}
        aria-controls={`${id}-fields`}
        aria-label={`${label}: ${options.account(route.providerAccountId) ? summary : "choose an account"}. Change`}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <ProviderGlyph provider={route.providerId} size="xs" />
        <span className={styles.summaryText}>{summary}</span>
        <ChevronDown className={styles.chevron} aria-hidden="true" />
      </button>
      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: a labelled group of selects inside a larger form row.
        <div id={`${id}-fields`} className={styles.fields} role="group" aria-label={label}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`${id}-agent`}>
              Agent
            </label>
            <Select
              id={`${id}-agent`}
              value={known ? choice : ""}
              disabled={disabled || !options.ready}
              onChange={(event) => {
                const [providerId, accountId] = event.target.value.split("\u0000");
                if (!providerId || !accountId) return;
                onChange({
                  providerId,
                  providerAccountId: accountId,
                  model: providerId === route.providerId && accountId === route.providerAccountId ? route.model : "",
                  effort: providerId === route.providerId ? route.effort : "",
                });
              }}
            >
              {known ? null : <option value="">{options.ready ? "Choose an account" : "Restoring accounts…"}</option>}
              {options.groups.map((group) => (
                <optgroup key={group.providerId} label={group.name}>
                  {group.accounts.map((account) => (
                    <option key={account.id} value={`${group.providerId}\u0000${account.id}`}>
                      {accountName(account)}
                      {options.usable(account.id) ? "" : " · signed out"}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`${id}-model`}>
              Model
            </label>
            <Select
              id={`${id}-model`}
              value={route.model}
              disabled={disabled || !route.providerAccountId}
              aria-busy={models.pending || undefined}
              onChange={(event) => onChange({ ...route, model: event.target.value })}
            >
              <option value="">{defaultModel ? `Default · ${defaultModel.displayName}` : "Provider default"}</option>
              {(models.items ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
              {route.model && !model ? <option value={route.model}>{route.model}</option> : null}
            </Select>
          </div>
          {efforts.length > 0 ? (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={`${id}-effort`}>
                Effort
              </label>
              <Select
                id={`${id}-effort`}
                value={route.effort && efforts.includes(route.effort) ? route.effort : ""}
                disabled={disabled}
                onChange={(event) => onChange({ ...route, effort: event.target.value })}
              >
                <option value="">{effectiveEffort ? `Default · ${effortLabel(effectiveEffort)}` : "Default"}</option>
                {efforts.map((level) => (
                  <option key={level} value={level}>
                    {effortLabel(level)}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {models.error ? <p className={styles.note}>{models.error} The provider default stays available.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
