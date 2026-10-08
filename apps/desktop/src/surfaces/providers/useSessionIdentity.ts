import { useOptionalProviderAccountSessions } from "./ProviderAccountSessions.tsx";
import { type SessionIdentityInput, sessionIdentity } from "./sessionIdentity.ts";

/** Reads the shell's shared snapshot; never starts a per-session metadata probe. */
export function useSessionIdentity(thread: SessionIdentityInput) {
  const sessions = useOptionalProviderAccountSessions();
  return sessionIdentity(thread, sessions?.accounts);
}
