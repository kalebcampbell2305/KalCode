import { Globe, X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import styles from "./LiveBrowserOffers.module.css";
import { agentLabel, devServerOffer, devServers, type LiveBrowserAgent } from "./liveBrowser.ts";
import { openLiveBrowser } from "./liveBrowserOpen.ts";
import { useLiveBrowserServices } from "./useLiveBrowserServices.ts";

// Dismissed offers last for the app session: the same server isn't offered twice.
const dismissed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
function dismiss(key: string) {
  dismissed.add(key);
  version += 1;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface LiveBrowserOffersProps {
  workspaceId: string;
  /** Addresses already shown in Live Browser panes of this workspace (never offered again). */
  openUrls?: readonly string[];
  className?: string;
}

/**
 * "localhost:3000 is up · Open Live Browser beside Claude Code 2". Appears when the shared
 * Operations Services projection sees a dev server in this workspace; one click opens it beside
 * the agent (or terminal) running it, on the far right when that pane has no room.
 */
export function LiveBrowserOffers({ workspaceId, openUrls = [], className }: LiveBrowserOffersProps) {
  const services = useLiveBrowserServices(workspaceId);
  const dismissedVersion = useSyncExternalStore(subscribe, () => version);
  const [agents, setAgents] = useState<LiveBrowserAgent[]>([]);
  const servers = devServers(services.snapshot?.services, workspaceId);
  const serverKey = servers.map((entry) => `${entry.service.id}:${entry.url}`).join("|");

  // Agents are read only when the set of servers changes (no polling of its own).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `serverKey` is the refresh signal.
  useEffect(() => {
    if (!serverKey) return;
    let cancelled = false;
    void services.listAgents().then(
      (list) => {
        if (!cancelled) setAgents(list);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [serverKey, workspaceId]);

  const openKey = openUrls.join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by stable strings.
  const offer = useMemo(
    () => devServerOffer(services.snapshot?.services, workspaceId, agents, openUrls, dismissed),
    [serverKey, workspaceId, agents, openKey, dismissedVersion],
  );
  if (!offer) return null;

  const beside = offer.agent ? `beside ${agentLabel(offer.agent)}` : null;
  return (
    <div className={`${styles.offer} ${className ?? ""}`} role="status" data-live-browser-offer={offer.host}>
      <span className={styles.pulse} aria-hidden="true" />
      <span className={styles.text}>
        <strong className={styles.host}>{offer.host}</strong> is up
      </span>
      <button
        type="button"
        className={styles.open}
        title={`${offer.serviceName}: ${offer.url}`}
        onClick={() => {
          dismiss(offer.key);
          openLiveBrowser({
            workspaceId,
            url: offer.url,
            beside: offer.agent
              ? { agentId: offer.agent.threadId }
              : offer.terminalId
                ? { terminalId: offer.terminalId }
                : null,
          });
        }}
      >
        <Globe size={13} aria-hidden="true" />
        Open Live Browser{beside ? <span className={styles.beside}> {beside}</span> : null}
      </button>
      <button
        type="button"
        className={styles.dismiss}
        aria-label={`Dismiss ${offer.host}`}
        title="Dismiss"
        onClick={() => dismiss(offer.key)}
      >
        <X size={12} />
      </button>
    </div>
  );
}
