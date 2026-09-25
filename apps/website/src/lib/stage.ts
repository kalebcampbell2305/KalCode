/**
 * Which product demos exist in src/components/stage (owned by the stage work). Pages use this to
 * compose a section only when its demo is present, so a missing demo never leaves an empty frame.
 */
const modules = import.meta.glob("../components/stage/*.astro");

export type StageName =
  | "AppWindow"
  | "ScrollStory"
  | "TryKalCode"
  | "ProviderSwitch"
  | "BeforeAfter"
  | "PermissionModes"
  | "KalVoiceDemo"
  | "DemoCenter"
  | "MultiAgentWall"
  | "KalVoiceStage"
  | "CommandCenterStage"
  | "MissionGraph"
  | "TimelineStage";

export function hasStage(name: StageName): boolean {
  return `../components/stage/${name}.astro` in modules;
}

/** The first demo of a list that exists, or null. */
export function firstStage(...names: StageName[]): StageName | null {
  return names.find(hasStage) ?? null;
}
