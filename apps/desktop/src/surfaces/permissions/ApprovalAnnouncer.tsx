import { useEffect, useRef, useState } from "react";
import { usePermissions } from "./PermissionsProvider.tsx";

/**
 * Screen-reader announcements for approvals: a new request is announced assertively (an agent
 * is blocked on you), so it is never missed even when the approvals panel is closed.
 */
export function ApprovalAnnouncer() {
  const { pending, pendingState } = usePermissions();
  const known = useRef<Set<string> | null>(null);
  // Each announcement is a new node, so a request whose text matches the previous one (the same
  // command asked for again) is still announced.
  const [message, setMessage] = useState<{ id: number; text: string } | null>(null);

  useEffect(() => {
    if (pendingState !== "ready") return;
    const ids = new Set(pending.map((view) => view.id));
    let text: string | null = null;
    if (known.current === null) {
      // First load: announce what is already waiting once, briefly.
      if (pending.length > 0)
        text = `${pending.length} ${pending.length === 1 ? "approval is" : "approvals are"} waiting for you.`;
    } else {
      const fresh = pending.filter((view) => !known.current?.has(view.id));
      const [newest] = fresh;
      if (newest) {
        const who = newest.context?.providerName ?? "An agent";
        text = `Approval needed. ${who} wants to: ${newest.action.summary}. Open Approvals in the sidebar to answer.${
          fresh.length > 1 ? ` ${fresh.length - 1} more waiting.` : ""
        }`;
      }
    }
    known.current = ids;
    if (text !== null) {
      const announced = text;
      setMessage((previous) => ({ id: (previous?.id ?? 0) + 1, text: announced }));
    }
  }, [pending, pendingState]);

  return (
    <div className="visually-hidden" role="alert" aria-live="assertive" aria-atomic="true">
      {message ? <p key={message.id}>{message.text}</p> : null}
    </div>
  );
}
