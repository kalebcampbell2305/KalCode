/**
 * Best-effort operating-system detection for download routing and the "Your system" marker.
 * Purely a convenience: every page still lists every platform.
 */
export type DetectedOs = "windows" | "macos" | "linux";

export function detectOs(): DetectedOs | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = `${nav.userAgentData?.platform ?? ""} ${navigator.userAgent}`.toLowerCase();
  if (hint.includes("windows") || hint.includes("win64") || hint.includes("win32")) return "windows";
  if (hint.includes("android") || hint.includes("iphone") || hint.includes("ipad")) return null;
  if (hint.includes("mac")) return "macos";
  if (hint.includes("linux") || hint.includes("x11")) return "linux";
  return null;
}
