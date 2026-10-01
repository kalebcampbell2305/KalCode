/**
 * Release-aware labels for the product stages (src/components/stage). The stages are sample
 * drawings of the app; their tags say how far along each drawn feature is. While /download serves
 * a Stable release, a feature Stable ships (crates/native-core/src/flags.rs, B9 536efd7: Dashboard,
 * KalVoice, Code, Threads, Providers and Settings are Available) is labelled with that release;
 * before then the preview-era tag stays.
 */
import { sampleThreads, type Thread } from "../data/story";
import {
  channelLabel,
  RELEASES,
  type ReleaseManifest,
  releaseDisplayVersion,
  releasePublicVersion,
  servedStableRelease,
} from "./releases";

/** A stage tag, plus the tag used once a Stable release is served ("{version}" is its version). */
export interface StageTag {
  tag: string;
  stableTag?: string;
}

export function stageTag(item: StageTag, manifest: ReleaseManifest = RELEASES): string {
  const stable = servedStableRelease(manifest);
  return stable && item.stableTag
    ? item.stableTag.replace(/\{version\}/g, releasePublicVersion(stable.version))
    : item.tag;
}

/** The build line in the sample app window: the served release, or "Development build" before one. */
export function stageBuildLabel(manifest: ReleaseManifest = RELEASES): string {
  const latest = manifest.latest;
  return latest ? `${channelLabel(manifest)} ${releaseDisplayVersion(latest.version)}` : "Development build";
}

/** True while /download serves a Stable release, so the sample rail shows Stable's surfaces. */
export function stageShowsStable(manifest: ReleaseManifest = RELEASES): boolean {
  return servedStableRelease(manifest) !== null;
}

/** The sample threads for a stage that carries a Stable tag (Gemini CLI swapped out on Stable). */
export function stageThreads(manifest: ReleaseManifest = RELEASES): readonly Thread[] {
  return sampleThreads(stageShowsStable(manifest));
}

export function stageThreadById(id: string, manifest: ReleaseManifest = RELEASES): Thread {
  const thread = stageThreads(manifest).find((t) => t.id === id);
  if (!thread) throw new Error(`Unknown stage thread: ${id}`);
  return thread;
}

/** A demo line, with its Stable wording once a Stable release is served. */
export function stageLine(item: { line: string; stableLine?: string }, manifest: ReleaseManifest = RELEASES): string {
  return stageShowsStable(manifest) && item.stableLine ? item.stableLine : item.line;
}

/** A step's screen-reader description, with its Stable wording once a Stable release is served. */
export function stageDescribe(
  item: { describe: string; stableDescribe?: string },
  manifest: ReleaseManifest = RELEASES,
): string {
  return stageShowsStable(manifest) && item.stableDescribe ? item.stableDescribe : item.describe;
}
