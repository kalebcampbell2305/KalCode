import { useEffect, useRef, useState } from "react";
import { usePermissions } from "./PermissionsProvider.tsx";

/**
 * Screen-reader announcements for approvals: a new request is announced assertively (an agent
 * is blocked on you), so it is never missed even when the approvals panel is closed.
 */
export function ApprovalAnnouncer() {
  const { pending, pendingState } = usePermissions();
  const known = useRef<Set<string> | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (pendingState !== "ready") return;
    const ids = new Set(pending.map((view) => view.id));
    if (known.current === null) {
      // First load: announce what is already waiting once, briefly.
      known.current = ids;
      if (pending.length > 0)
        setMessage(`${pending.length} ${pending.length === 1 ? "approval is" : "approvals are"} waiting for you.`);
      return;
    }
    const fresh = pending.filter((view) => !known.current?.has(view.id));
    known.current = ids;
    const [newest] = fresh;
    if (newest) {
      const who = newest.context?.providerName ?? "An agent";
      setMessage(
        `Approval needed. ${who} wants to: ${newest.action.summary}. Open Approvals in the sidebar to answer.${
          fresh.length > 1 ? ` ${fresh.length - 1} more waiting.` : ""
        }`,
      );
    }
  }, [pending, pendingState]);

  return (
    <div className="visually-hidden" role="alert" aria-live="assertive" aria-atomic="true">
      {message}
    </div>
  );
}
