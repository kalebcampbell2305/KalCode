import type { VoiceSceneKind, VoiceSceneReference } from "./sceneTargets.ts";

function kindHint(query: string): readonly VoiceSceneKind[] | undefined {
  if (/\bterminal\b/i.test(query)) return ["terminal", "thread"];
  if (/\b(?:agent|session|thread)\b/i.test(query)) return ["thread", "agent"];
  if (/\b(?:workspace|project)\b/i.test(query)) return ["workspace", "remote_workspace"];
  return undefined;
}

/** Only read-only object addressing. Prompts and app mutations stay with their canonical routers. */
export function sceneReference(text: string): VoiceSceneReference | null {
  const spoken = text
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
  const match = /^(?:please )?(?:find|focus|open|show me|show|go to|take me to)\s+(.+)$/i.exec(spoken);
  if (!match?.[1]) return null;
  const query = match[1].replace(/^(?:the|my)\s+/i, "");
  if (/\b(?:and|then|don't|not|never)\b/i.test(query)) return null;
  if (/^(?:it|that|that one|same (?:terminal|agent|thread))$/i.test(query)) return { kind: "last_target" };
  if (/^(?:this|this (?:terminal|agent|thread|pane)|current (?:terminal|agent|thread|pane))$/i.test(query))
    return { kind: "current" };
  if (/^(?:(?:terminal|pane|one) )?(?:beside|next to) (?:this|this one|this terminal|me)$/i.test(query))
    return { kind: "beside_current" };
  // "The agent that just finished" means a coding agent; "the thing/thread that just finished" means anything.
  const finished = /^(thing|one|agent|terminal|thread) (?:that )?just (?:finished|completed)$/i.exec(query);
  if (finished)
    return /^agent$/i.test(finished[1] ?? "")
      ? { kind: "latest_completed", agents: true }
      : { kind: "latest_completed" };
  const failed = /^last failed (terminal|agent|thread|task)$/i.exec(query);
  if (failed)
    return /^agent$/i.test(failed[1] ?? "") ? { kind: "latest_failed", agents: true } : { kind: "latest_failed" };
  if (/^other\s+/i.test(query)) {
    const named = query.replace(/^other\s+/i, "");
    return { kind: "other", query: named, kinds: kindHint(named) };
  }
  // Surface names win over an identically named runtime object. Creation stays native as well.
  if (
    /^(?:dashboard|home|overview|operations|missions|runs?|queue|services?|environments?|activity|settings|preferences|code|editor|browser|localhost|threads|agents|agent fleet|providers|provider accounts|kalvoice|voice|command center|automations|skills|plugins|integrations|memory|memories)$/i.test(
      query,
    )
  )
    return null;
  if (/^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|new)\s+/i.test(query)) return null;
  return { kind: "named", query, kinds: kindHint(query) };
}
