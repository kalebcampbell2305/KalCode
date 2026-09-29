/**
 * Release-aware labels for the product stages (src/components/stage). The stages are sample
 * drawings of the app; their tags say how far along each drawn feature is. While /download serves
 * a Stable release, a feature Stable ships (crates/native-core/src/flags.rs, B9 536efd7: Dashboard,
 * KalVoice, Code, Threads, Providers and Settings are Available) is labelled with that release;
 * before then the preview-era tag stays.
 */
import { channelLabel, RELEASES, type ReleaseManifest, servedStableRelease } from "./releases";

/** A stage tag, plus the tag used once a Stable release is served ("{version}" is its version). */
export interface StageTag {
  tag: string;
  stableTag?: string;
}

export function stageTag(item: StageTag, manifest: ReleaseManifest = RELEASES): string {
  const stable = servedStableRelease(manifest);
  return stable && item.stableTag ? item.stableTag.replace(/\{version\}/g, stable.version) : item.tag;
}

/** The build line in the sample app window: the served release, or "Development build" before one. */
export function stageBuildLabel(manifest: ReleaseManifest = RELEASES): string {
  const latest = manifest.latest;
  return latest ? `${channelLabel(manifest)} ${latest.version}` : "Development build";
}

/** True while /download serves a Stable release, so the sample rail shows Stable's surfaces. */
export function stageShowsStable(manifest: ReleaseManifest = RELEASES): boolean {
  return servedStableRelease(manifest) !== null;
}
