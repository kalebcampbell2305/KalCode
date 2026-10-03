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

interface PermissionSnapshot {
  pending: ApprovalView[];
  pendingState: LoadState;
  pendingError: KalCodeError | null;
  settings: PermissionSettings | null;
  profiles: PermissionProfile[];
  panelOpen: boolean;
}

const EMPTY: PermissionSnapshot = {
  pending: [],
  pendingState: "loading",
  pendingError: null,
  settings: null,
  profiles: [],
  panelOpen: false,
};

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { events } = useEvents();
  const toast = useToast();
  const lifecycle = useMemo(
    () => ({ client, mounted: false, epoch: 0, pending: 0, mode: 0, tail: Promise.resolve() }),
    [client],
  );
  const current = useRef(lifecycle);
  current.current = lifecycle;
  const isCurrent = useCallback(
    (epoch = lifecycle.epoch) => lifecycle.mounted && current.current === lifecycle && epoch === lifecycle.epoch,
    [lifecycle],
  );
  const [snapshot, setSnapshot] = useState({ lifecycle, ...EMPTY });
  // Hide the previous client's state during render, before effect cleanup/setup.
  const { pending, pendingState, pendingError, settings, profiles, panelOpen } =
    snapshot.lifecycle === lifecycle ? snapshot : EMPTY;
  const update = useCallback(
    (change: Partial<PermissionSnapshot>) => {
      setSnapshot((previous) => ({ ...(previous.lifecycle === lifecycle ? previous : EMPTY), lifecycle, ...change }));
    },
    [lifecycle],
  );
  const opener = useRef<HTMLElement | null>(null);
  const setPanelOpen = useCallback(
    (open: boolean) => {
      if (!isCurrent()) return;
      if (open && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
      update({ panelOpen: open });
    },
    [isCurrent, update],
  );
  const panelReturnFocus = useCallback(() => {
    if (!isCurrent()) return;
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) target.focus();
  }, [isCurrent]);

  useEffect(() => {
    lifecycle.mounted = true;
    update(EMPTY);
    opener.current = null;
    return () => {
      lifecycle.mounted = false;
      lifecycle.epoch += 1;
      lifecycle.pending += 1;
      lifecycle.mode += 1;
    };
  }, [lifecycle, update]);

  const refreshPending = useCallback(async () => {
    if (!isCurrent()) return;
    const epoch = lifecycle.epoch;
    const id = ++lifecycle.pending;
    try {
      const next = await client.listApprovals("pending");
      if (!isCurrent(epoch) || id !== lifecycle.pending) return;
      update({ pending: next, pendingState: "ready", pendingError: null });
    } catch (error) {
      if (!isCurrent(epoch) || id !== lifecycle.pending) return;
      update({ pendingError: toKalCodeError(error), pendingState: "error" });
    }
  }, [client, lifecycle, isCurrent, update]);

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
    const epoch = lifecycle.epoch;
    const mode = lifecycle.mode;
    Promise.all([client.getPermissionSettings(), client.listPermissionProfiles()])
      .then(([nextSettings, nextProfiles]) => {
        if (cancelled || !isCurrent(epoch)) return;
        update({ profiles: nextProfiles, ...(mode === lifecycle.mode ? { settings: nextSettings } : {}) });
      })
      .catch((error) => {
        if (!cancelled && isCurrent(epoch))
          toast.show({
            tone: "danger",
            title: "Permission settings unavailable",
            description: toKalCodeError(error).message,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [client, toast, lifecycle, isCurrent, update]);

  // "Try again" on a failed answer re-sends it through the current `decide`.
  const decideRef = useRef<(requestId: string, decision: ApprovalDecision) => Promise<unknown>>(async () => null);
  const decide = useCallback(
    async (requestId: string, decision: ApprovalDecision) => {
      if (!isCurrent()) return null;
      const epoch = lifecycle.epoch;
      try {
        const updated = await client.decideApproval(requestId, decision);
        if (!isCurrent(epoch)) return null;
        // A read captured before this answer must not restore the resolved request.
        lifecycle.pending += 1;
        setSnapshot((previous) => ({
          ...previous,
          pending: previous.pending.filter((view) => view.id !== requestId),
        }));
        void refreshPending();
        return updated;
      } catch (error) {
        if (!isCurrent(epoch)) return null;
        const failure = toKalCodeError(error);
        toast.show({
          tone: "danger",
          title: "Couldn't record your answer",
          description: failure.message,
          action: { label: "Try again", onSelect: () => void decideRef.current(requestId, decision) },
        });
        void refreshPending();
        return null;
      }
    },
    [client, toast, refreshPending, lifecycle, isCurrent],
  );
  decideRef.current = decide;

  const setDefaultMode = useCallback(
    async (mode: PermissionMode, options: { profileId?: string | null; confirmed?: boolean } = {}) => {
      if (!isCurrent()) return false;
      const epoch = lifecycle.epoch;
      const request = ++lifecycle.mode;
      // Capture options now; callers may retain or mutate the object while queued.
      const parameters = {
        profileId: options.profileId ?? null,
        confirmBypass: mode === "bypass" ? options.confirmed === true : undefined,
      };
      const operation = lifecycle.tail.then(async () => {
        if (!isCurrent(epoch)) return false;
        try {
          const next = await client.updatePermissionSettings(mode, parameters);
          if (!isCurrent(epoch)) return false;
          if (request === lifecycle.mode) update({ settings: next });
          return request === lifecycle.mode;
        } catch (error) {
          if (!isCurrent(epoch)) return false;
          toast.show({
            tone: "danger",
            title: "Permission mode not changed",
            description: toKalCodeError(error).message,
          });
          // A previous queued write may have succeeded. Re-read actual policy on failure.
          // Do not hold the write queue while this read is in flight.
          if (request === lifecycle.mode) {
            update({ settings: null });
            void client.getPermissionSettings().then(
              (next) => {
                if (isCurrent(epoch) && request === lifecycle.mode) update({ settings: next });
              },
              () => {},
            );
          }
          return false;
        }
      });
      lifecycle.tail = operation.then(() => {});
      return operation;
    },
    [client, toast, lifecycle, isCurrent, update],
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
