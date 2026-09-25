import type {
  ApprovalDecision,
  ApprovalView,
  PermissionMode,
  PermissionProfile,
  PermissionSettings,
} from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";

type LoadState = "loading" | "ready" | "error";

export interface PermissionsValue {
  /** Pending approval requests, newest first. */
  pending: ApprovalView[];
  pendingState: LoadState;
  pendingError: KalCodeError | null;
  refreshPending: () => Promise<void>;
  /** Answers a request. Resolves to the updated request, or null when it failed (toast shown). */
  decide: (requestId: string, decision: ApprovalDecision) => Promise<ApprovalView | null>;
  settings: PermissionSettings | null;
  profiles: PermissionProfile[];
  /** Changes the default mode. Bypass is sent with `confirmBypass` only when `confirmed`. */
  setDefaultMode: (
    mode: PermissionMode,
    options?: { profileId?: string | null; confirmed?: boolean },
  ) => Promise<boolean>;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  /** Where focus returns when the approvals panel closes (the control that opened it). */
  panelReturnFocus: () => void;
}

const PermissionsContext = createContext<PermissionsValue | null>(null);

/** Event types after which pending approvals are re-read. */
const APPROVAL_EVENTS = new Set(["approval.requested", "approval.approved", "approval.denied", "approval.expired"]);

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { events } = useEvents();
  const toast = useToast();
  const [pending, setPending] = useState<ApprovalView[]>([]);
  const [pendingState, setPendingState] = useState<LoadState>("loading");
  const [pendingError, setPendingError] = useState<KalCodeError | null>(null);
  const [settings, setSettings] = useState<PermissionSettings | null>(null);
  const [profiles, setProfiles] = useState<PermissionProfile[]>([]);
  const [panelOpen, setPanelOpenState] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const setPanelOpen = useCallback((open: boolean) => {
    if (open && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
    setPanelOpenState(open);
  }, []);
  const panelReturnFocus = useCallback(() => {
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) target.focus();
  }, []);
  const generation = useRef(0);

  const refreshPending = useCallback(async () => {
    const id = ++generation.current;
    try {
      const next = await client.listApprovals("pending");
      if (id !== generation.current) return;
      setPending(next);
      setPendingState("ready");
      setPendingError(null);
    } catch (error) {
      if (id !== generation.current) return;
      setPendingError(toKalCodeError(error));
      setPendingState("error");
    }
  }, [client]);

  // Re-read whenever an approval event arrives (the event feed is ordered by seq).
  const latestApprovalSeq = useMemo(
    () => events.reduce((max, event) => (APPROVAL_EVENTS.has(event.type) ? Math.max(max, event.seq) : max), 0),
    [events],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `latestApprovalSeq` triggers the re-read.
  useEffect(() => {
    void refreshPending();
  }, [refreshPending, latestApprovalSeq]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.getPermissionSettings(), client.listPermissionProfiles()])
      .then(([nextSettings, nextProfiles]) => {
        if (cancelled) return;
        setSettings(nextSettings);
        setProfiles(nextProfiles);
      })
      .catch((error) => {
        if (!cancelled)
          toast.show({
            tone: "danger",
            title: "Permission settings unavailable",
            description: toKalCodeError(error).message,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [client, toast]);

  const decide = useCallback(
    async (requestId: string, decision: ApprovalDecision) => {
      try {
        const updated = await client.decideApproval(requestId, decision);
        setPending((current) => current.filter((view) => view.id !== requestId));
        return updated;
      } catch (error) {
        const failure = toKalCodeError(error);
        toast.show({ tone: "danger", title: "Couldn't record your answer", description: failure.message });
        void refreshPending();
        return null;
      }
    },
    [client, toast, refreshPending],
  );

  const setDefaultMode = useCallback(
    async (mode: PermissionMode, options: { profileId?: string | null; confirmed?: boolean } = {}) => {
      try {
        const next = await client.updatePermissionSettings(mode, {
          profileId: options.profileId ?? null,
          confirmBypass: mode === "bypass" ? options.confirmed === true : undefined,
        });
        setSettings(next);
        return true;
      } catch (error) {
        toast.show({
          tone: "danger",
          title: "Permission mode not changed",
          description: toKalCodeError(error).message,
        });
        return false;
      }
    },
    [client, toast],
  );

  const value = useMemo<PermissionsValue>(
    () => ({
      pending,
      pendingState,
      pendingError,
      refreshPending,
      decide,
      settings,
      profiles,
      setDefaultMode,
      panelOpen,
      setPanelOpen,
      panelReturnFocus,
    }),
    [
      pending,
      pendingState,
      pendingError,
      refreshPending,
      decide,
      settings,
      profiles,
      setDefaultMode,
      panelOpen,
      setPanelOpen,
      panelReturnFocus,
    ],
  );

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermissions(): PermissionsValue {
  const value = useContext(PermissionsContext);
  if (!value) throw new Error("usePermissions must be used inside <PermissionsProvider>");
  return value;
}
