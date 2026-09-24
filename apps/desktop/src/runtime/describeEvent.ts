import type { EventEnvelope } from "@kalcode/protocol";

export type EventTone = "live" | "success" | "waiting" | "danger" | "idle";

export interface EventDescription {
  title: string;
  detail: string | null;
  tone: EventTone;
}

const SETTING_LABELS: Record<string, string> = {
  "appearance.theme": "Theme",
  "appearance.motion": "Motion",
  "appearance.density": "Density",
  "layout.sidebarCollapsed": "Sidebar",
};

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Human-readable description of an event for the activity feed. */
export function describeEvent(event: EventEnvelope): EventDescription {
  switch (event.type) {
    case "app.started":
      return {
        title: "KalCode started",
        detail: `Version ${event.payload.version}, ${event.payload.channel} build`,
        tone: "live",
      };
    case "app.stopped":
      return { title: "KalCode closed", detail: `Ran for ${formatDuration(event.payload.uptimeMs)}`, tone: "idle" };
    case "app.previous_session_interrupted":
      return {
        title: "Previous session ended unexpectedly",
        detail: `Last recorded activity ${formatAbsolute(event.payload.lastEventAt)}`,
        tone: "waiting",
      };
    case "database.migrated":
      return event.payload.fromVersion === 0
        ? { title: "Local database created", detail: `Schema version ${event.payload.toVersion}`, tone: "success" }
        : {
            title: "Local database upgraded",
            detail: `Schema ${event.payload.fromVersion} to ${event.payload.toVersion}${
              event.payload.backupCreated ? ", backup saved" : ""
            }`,
            tone: "success",
          };
    case "settings.changed": {
      const labels = event.payload.keys.map((key) => SETTING_LABELS[key] ?? key);
      return { title: "Settings changed", detail: labels.length ? joinList(labels) : null, tone: "idle" };
    }
    case "secure_store.checked":
      return event.payload.ok
        ? { title: "Credential store verified", detail: event.payload.backend, tone: "success" }
        : { title: "Credential store check failed", detail: event.payload.backend, tone: "danger" };
    case "unrecognized":
      return {
        title: "Event from a newer KalCode",
        detail: `${event.payload.originalType} (version ${event.payload.originalVersion})`,
        tone: "idle",
      };
  }
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const ABSOLUTE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export function formatRelative(iso: string, now: number = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return RELATIVE.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return RELATIVE.format(Math.round(diff / 3600), "hour");
  return RELATIVE.format(Math.round(diff / 86_400), "day");
}

export function formatAbsolute(iso: string): string {
  return ABSOLUTE.format(new Date(iso));
}
