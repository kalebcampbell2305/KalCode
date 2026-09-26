import { describe, expect, it } from "vitest";
import {
  detectDesktopPlatform,
  formatShortcut,
  hasPrimaryModifier,
  type PlatformNavigator,
} from "./keyboard.ts";

function navigatorWith(values: Partial<PlatformNavigator>): PlatformNavigator {
  return { platform: "", userAgent: "", ...values };
}

describe("desktop platform detection", () => {
  it("prefers the structured user-agent platform when the browser provides it", () => {
    expect(
      detectDesktopPlatform(
        navigatorWith({ platform: "Win32", userAgentData: { platform: "macOS" } }),
      ),
    ).toBe("macos");
  });

  it("recognizes legacy macOS, Windows, and Linux browser signals", () => {
    expect(detectDesktopPlatform(navigatorWith({ platform: "MacIntel" }))).toBe("macos");
    expect(detectDesktopPlatform(navigatorWith({ platform: "Win32" }))).toBe("windows");
    expect(detectDesktopPlatform(navigatorWith({ platform: "Linux x86_64" }))).toBe("linux");
    expect(detectDesktopPlatform(navigatorWith({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" }))).toBe(
      "macos",
    );
  });

  it("reports unknown instead of claiming an operating system without a signal", () => {
    expect(detectDesktopPlatform()).toBe("unknown");
    expect(detectDesktopPlatform(navigatorWith({}))).toBe("unknown");
  });
});

describe("primary modifier conventions", () => {
  it("uses Command only on macOS and Control on Windows/Linux", () => {
    expect(hasPrimaryModifier({ ctrlKey: false, metaKey: true }, "macos")).toBe(true);
    expect(hasPrimaryModifier({ ctrlKey: true, metaKey: false }, "macos")).toBe(false);
    expect(hasPrimaryModifier({ ctrlKey: true, metaKey: false }, "windows")).toBe(true);
    expect(hasPrimaryModifier({ ctrlKey: false, metaKey: true }, "windows")).toBe(false);
    expect(hasPrimaryModifier({ ctrlKey: true, metaKey: false }, "linux")).toBe(true);
    expect(hasPrimaryModifier({ ctrlKey: true, metaKey: true }, "macos")).toBe(false);
  });

  it("formats the same action with native menu labels", () => {
    expect(formatShortcut(["Mod", "Shift", "K"], "macos")).toBe("⌘ ⇧ K");
    expect(formatShortcut(["Mod", "Alt", "ArrowLeft"], "macos")).toBe("⌘ ⌥ ←");
    expect(formatShortcut(["Mod", "Shift", "K"], "windows")).toBe("Ctrl Shift K");
    expect(formatShortcut(["Mod", "Alt", "ArrowLeft"], "windows")).toBe("Ctrl Alt ←");
  });
});
