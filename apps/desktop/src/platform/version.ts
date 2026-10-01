/**
 * KalCode version strings. A production build is `X.Y.Z+N`: the public version `X.Y.Z` and the
 * internal build number `N`. A plain `X.Y.Z` has no build number. The UI always leads with the
 * public version and adds "build N" only where the version is shown in detail.
 */
export interface AppVersion {
  /** The public (marketing) version, e.g. "0.1.7". */
  public: string;
  /** The internal build number, or null when the version carries none. */
  build: number | null;
}

export function parseAppVersion(version: string): AppVersion {
  const plus = version.indexOf("+");
  if (plus === -1) return { public: version, build: null };
  const metadata = version.slice(plus + 1);
  const build = /^[1-9]\d{0,15}$/.test(metadata) ? Number(metadata) : null;
  return { public: version.slice(0, plus), build: build !== null && Number.isSafeInteger(build) ? build : null };
}

/** "0.1.7" for "0.1.7+780". */
export function publicVersion(version: string): string {
  return parseAppVersion(version).public;
}

/** "0.1.7 build 780" for "0.1.7+780"; "0.1.7" when there is no build number. */
export function formatVersion(version: string): string {
  const { public: base, build } = parseAppVersion(version);
  return build === null ? base : `${base} build ${build}`;
}

/**
 * The build number of `next` when it is a newer build of the same public version as `current`
 * (an internal build update, e.g. 0.1.7 → 0.1.7+780); otherwise null.
 */
export function sameVersionBuild(current: string | null | undefined, next: string): number | null {
  if (!current) return null;
  const parsed = parseAppVersion(next);
  return parsed.build !== null && parseAppVersion(current).public === parsed.public ? parsed.build : null;
}
