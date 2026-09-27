import { execFileSync } from "node:child_process";

/** Actual OS input for WebView2 controller focus; CDP input only targets the renderer. */
export function clickOwnedClientPoint(pid: number | undefined, x: number, y: number): void {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0 || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new Error("Native pointer input requires an owned process and integer client coordinates.");
  }
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedPointer {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
if ([OwnedPointer]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -eq [IntPtr]::Zero) {
  throw 'Cannot use physical client coordinates for native pointer input.'
}
$ownedProcess = Get-Process -Id ${pid}
$window = $ownedProcess.MainWindowHandle
if ($window -eq [IntPtr]::Zero) { throw 'Owned E2E process has no main window.' }
$windowPid = [uint32]0
[void][OwnedPointer]::GetWindowThreadProcessId($window, [ref]$windowPid)
if ($windowPid -ne ${pid}) { throw 'E2E window does not belong to the owned process.' }
$client = New-Object OwnedPointer+Rect
if (-not [OwnedPointer]::GetClientRect($window, [ref]$client)) { throw 'Cannot inspect owned client bounds.' }
if (${x} -lt $client.Left -or ${x} -ge $client.Right -or ${y} -lt $client.Top -or ${y} -ge $client.Bottom) {
  throw 'Pointer request is outside the owned client bounds.'
}
if (-not [OwnedPointer]::SetForegroundWindow($window)) { throw 'Cannot activate owned E2E window.' }
if ([OwnedPointer]::GetForegroundWindow() -ne $window) { throw 'Owned E2E window is not foreground.' }
$point = New-Object OwnedPointer+Point
$point.X = ${x}; $point.Y = ${y}
if (-not [OwnedPointer]::ClientToScreen($window, [ref]$point)) { throw 'Cannot resolve owned client point.' }
$original = New-Object OwnedPointer+Point
if (-not [OwnedPointer]::GetCursorPos([ref]$original)) { throw 'Cannot retain original pointer position.' }
try {
  if (-not [OwnedPointer]::SetCursorPos($point.X, $point.Y)) { throw 'Cannot position native pointer.' }
  $root = [OwnedPointer]::GetAncestor([OwnedPointer]::WindowFromPoint($point), 2)
  if ($root -ne $window -or [OwnedPointer]::GetForegroundWindow() -ne $window) {
    throw 'Pointer target is not the owned foreground E2E window.'
  }
  [OwnedPointer]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [OwnedPointer]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
} finally {
  if (-not [OwnedPointer]::SetCursorPos($original.X, $original.Y)) { throw 'Cannot restore pointer position.' }
}
'clicked-owned-window'
`;
  const output = execFileSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (!output.trim().endsWith("clicked-owned-window")) throw new Error("Owned native pointer action did not finish.");
}
