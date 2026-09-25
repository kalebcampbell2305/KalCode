/**
 * Marks the visitor's operating system on <html data-os="…"> so the download page can highlight
 * the matching row. Detection is best-effort and purely cosmetic: every row stays visible.
 */
type Os = "windows" | "macos" | "linux";

function detect(): Os | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = `${nav.userAgentData?.platform ?? ""} ${navigator.userAgent}`.toLowerCase();
  if (hint.includes("windows") || hint.includes("win64") || hint.includes("win32")) return "windows";
  if (hint.includes("android") || hint.includes("iphone") || hint.includes("ipad")) return null;
  if (hint.includes("mac")) return "macos";
  if (hint.includes("linux") || hint.includes("x11")) return "linux";
  return null;
}

const os = detect();
if (os) document.documentElement.dataset.os = os;
