import { useEffect, useRef } from "react";
import { useDeskRestore } from "../runtime/deskRestore.ts";
import { useWorkspaces } from "../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "./navigation.tsx";

/**
 * Makes Code the returning-user start surface after the one initial workspace restore. Any
 * accepted navigation while that restore is pending wins, including a click on the current page.
 */
export function CodeStartup() {
  const { automatic } = useDeskRestore();
  const { state, active } = useWorkspaces();
  const { current, navigate, getIntentRevision } = useNavigation();
  const initialIntentRevision = useRef(getIntentRevision());
  const initialRestoreSettled = useRef(false);

  useEffect(() => {
    if (initialRestoreSettled.current || state === "loading") return;
    initialRestoreSettled.current = true;
    if (getIntentRevision() !== initialIntentRevision.current) return;
    navigate(automatic && state === "ready" && active ? "code" : current);
  }, [active, automatic, current, getIntentRevision, navigate, state]);

  return null;
}
