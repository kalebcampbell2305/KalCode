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
  "kalvoice.dictationShortcut": "KalVoice dictation shortcut",
  "kalvoice.commandShortcut": "KalVoice command shortcut",
  "kalvoice.intelligence": "KalVoice intelligence",
  "kalvoice.speechModel": "KalVoice speech model",
  "kalvoice.voiceReplies": "KalVoice spoken replies",
  "kalvoice.panelDefault": "KalVoice assistant position",
  "kalvoice.panelVisible": "KalVoice assistant visibility",
  "kalvoice.panelPlacements": "KalVoice assistant layout",
};

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

/** A provider's display name; unknown ids are shown as-is. */
export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}

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
    case "workspace.created":
      return { title: "Workspace added", detail: event.payload.name, tone: "success" };
    case "workspace.opened":
      return { title: "Workspace opened", detail: event.payload.name, tone: "idle" };
    case "workspace.removed":
      return { title: "Workspace removed from KalCode", detail: event.payload.name, tone: "idle" };
    case "shell.started":
      return { title: "Terminal started", detail: event.payload.shellName, tone: "live" };
    case "shell.completed":
      return event.payload.closedByUser
        ? { title: "Terminal closed", detail: null, tone: "idle" }
        : { title: "Terminal exited", detail: `Exit code ${event.payload.exitCode}`, tone: "idle" };
    case "shell.failed":
      return { title: "Terminal exited with an error", detail: `Exit code ${event.payload.exitCode}`, tone: "danger" };
    case "provider.detected":
      return {
        title: event.payload.installed ? "Provider detected" : "Provider not installed",
        detail: [providerName(event.payload.providerId), event.payload.version].filter(Boolean).join(" "),
        tone: event.payload.installed ? "success" : "idle",
      };
    case "provider.connected":
      return {
        title: "Provider connected",
        detail: event.payload.accountLabel ?? providerName(event.payload.providerId),
        tone: "success",
      };
    case "provider.disconnected":
      return {
        title: "Provider disconnected",
        detail: event.payload.accountLabel ?? providerName(event.payload.providerId),
        tone: "waiting",
      };
    case "provider.error":
      return {
        title: `${providerName(event.payload.providerId)} couldn't be checked`,
        detail: event.payload.message,
        tone: "danger",
      };
    case "thread.created":
      return { title: "Thread created", detail: event.payload.name, tone: "success" };
    case "thread.started":
      return { title: "Thread started", detail: null, tone: "live" };
    case "thread.status_changed":
      return {
        title: "Thread status changed",
        detail: event.payload.detail ?? event.payload.to.replaceAll("_", " "),
        tone: "live",
      };
    case "thread.renamed":
      return { title: "Thread renamed", detail: event.payload.name, tone: "idle" };
    case "thread.completed":
      return { title: "Thread completed", detail: null, tone: "success" };
    case "thread.failed":
      return { title: "Thread failed", detail: event.payload.message, tone: "danger" };
    case "thread.archived":
      return { title: "Thread archived", detail: null, tone: "idle" };
    case "agent.message":
      return { title: event.payload.role === "user" ? "Message sent" : "Message received", detail: null, tone: "idle" };
    case "tool.requested":
      return { title: "Tool requested", detail: event.payload.summary, tone: "live" };
    case "tool.started":
      return { title: "Tool running", detail: null, tone: "live" };
    case "tool.completed":
      return { title: "Tool finished", detail: null, tone: "success" };
    case "tool.failed":
      return { title: "Tool failed", detail: event.payload.summary, tone: "danger" };
    case "file.created":
      return { title: "File created", detail: event.payload.path, tone: "idle" };
    case "file.modified":
      return { title: "File changed", detail: event.payload.path, tone: "idle" };
    case "file.deleted":
      return { title: "File deleted", detail: event.payload.path, tone: "waiting" };
    case "approval.requested":
      return { title: "Approval needed", detail: event.payload.summary, tone: "waiting" };
    case "approval.approved":
      return { title: "Approved", detail: event.payload.decision.replaceAll("_", " "), tone: "success" };
    case "approval.denied":
      return { title: "Denied", detail: null, tone: "idle" };
    case "approval.expired":
      return { title: "Approval request expired", detail: null, tone: "idle" };
    case "permission.mode_changed":
      return {
        title: "Permission mode changed",
        detail: `${event.payload.from} to ${event.payload.to}`,
        tone: "waiting",
      };
    case "kalvoice.dictation_started":
      return { title: "KalVoice dictation started", detail: null, tone: "live" };
    case "kalvoice.dictation_completed":
      return {
        title: "KalVoice dictation inserted",
        detail: `${event.payload.characters.toLocaleString()} characters`,
        tone: "success",
      };
    case "kalvoice.dictation_failed":
      return { title: "KalVoice dictation failed", detail: event.payload.code.replaceAll("_", " "), tone: "danger" };
    case "kalvoice.request_started":
      return { title: "KalVoice request", detail: event.payload.input === "voice" ? "Spoken" : "Typed", tone: "live" };
    case "kalvoice.command_recognized":
      return {
        title: "KalVoice understood a command",
        detail: event.payload.intent.replaceAll("_", " "),
        tone: "live",
      };
    case "kalvoice.command_executed":
      return { title: "KalVoice ran a command", detail: event.payload.intent.replaceAll("_", " "), tone: "success" };
    case "kalvoice.request_completed":
      return { title: "KalVoice request completed", detail: null, tone: "success" };
    case "kalvoice.request_failed":
      return { title: "KalVoice request failed", detail: event.payload.code.replaceAll("_", " "), tone: "danger" };
    case "kalvoice.limit_reached":
      return {
        title: "Monthly KalVoice Requests used",
        detail: `${event.payload.allowance.toLocaleString()} requests; resets ${formatAbsolute(event.payload.resetsAt)}`,
        tone: "waiting",
      };
    case "kalvoice.provider_selected":
      return {
        title: "KalVoice intelligence changed",
        detail:
          event.payload.intelligence.kind === "provider" ? event.payload.intelligence.providerId : "On-device model",
        tone: "idle",
      };
    case "kalvoice.voice_output_started":
      return { title: "KalVoice speaking", detail: null, tone: "live" };
    case "kalvoice.voice_output_completed":
      return { title: "KalVoice finished speaking", detail: null, tone: "idle" };
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
