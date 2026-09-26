/** Windows process probes, via Windows PowerShell (always present on Windows 10/11). */
import { execFile, execFileSync, spawn } from "node:child_process";
import type { ProcessProbe, ProcessSample, WindowWatcher } from "./platform.ts";

function encoded(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const POWERSHELL = "powershell.exe";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"];

/** Every process descended from the root (WebView2 browser, renderer, GPU, utility processes). */
function treeScript(rootPid: number): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$children = @{}
$commandLines = @{}
foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine)) {
  $commandLines[[int]$p.ProcessId] = [string]$p.CommandLine
  $parent = [int]$p.ParentProcessId
  if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.ArrayList }
  [void]$children[$parent].Add([int]$p.ProcessId)
}
$queue = New-Object System.Collections.Queue
$queue.Enqueue(${rootPid})
$seen = @{}
$out = New-Object System.Collections.ArrayList
while ($queue.Count -gt 0) {
  $id = $queue.Dequeue()
  if ($seen.ContainsKey($id)) { continue }
  $seen[$id] = $true
  $proc = Get-Process -Id $id
  if ($proc) {
    $role = 'main'
    if ($id -ne ${rootPid}) {
      $role = 'browser'
      if ($commandLines[$id] -match '--type=([a-z-]+)') { $role = $Matches[1] }
      if ($commandLines[$id] -match '--utility-sub-type=([a-zA-Z.]+)') { $role = "utility:" + $Matches[1] }
    }
    [void]$out.Add([pscustomobject]@{
      pid = $id; name = $proc.ProcessName; role = $role; workingSet = $proc.WorkingSet64;
      privateBytes = $proc.PrivateMemorySize64; cpuMs = $proc.TotalProcessorTime.TotalMilliseconds
    })
    if ($children.ContainsKey($id)) { foreach ($child in $children[$id]) { $queue.Enqueue($child) } }
  }
}
ConvertTo-Json -Compress -InputObject @($out)
`;
}

/**
 * Prints READY, reads a PID from stdin, then polls every 2 ms until the process owns a
 * top-level window the user can actually see, and prints that epoch ms. "Visible" means
 * WS_VISIBLE, unowned, not DWM-cloaked, titled and at least 100×100. (`MainWindowHandle` is not
 * enough: tao's untitled "Tao Thread Event Target" helper window has WS_VISIBLE.) The C#
 * is compiled before READY, so compilation never delays the app being measured.
 */
const WATCHER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class KalCodeWindowWatch {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  static bool Seen(uint target) {
    bool found = false;
    EnumWindows((hwnd, l) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid != target || !IsWindowVisible(hwnd) || GetWindow(hwnd, 4) != IntPtr.Zero) return true;
      int cloaked = 0; DwmGetWindowAttribute(hwnd, 14, out cloaked, 4);
      Rect r; GetWindowRect(hwnd, out r);
      bool sized = r.Right - r.Left >= 100 && r.Bottom - r.Top >= 100;
      if (cloaked == 0 && sized && GetWindowTextLength(hwnd) > 0) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static long Wait(int pid, int timeoutMs) {
    var proc = System.Diagnostics.Process.GetProcessById(pid);
    var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    while (DateTime.UtcNow < deadline) {
      if (Seen((uint)pid)) return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      if (proc.HasExited) return -1;
      Thread.Sleep(2);
    }
    return -2;
  }
}
"@
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
$target = [int]([Console]::In.ReadLine())
$at = [KalCodeWindowWatch]::Wait($target, [int]$env:KALCODE_PERF_WATCH_TIMEOUT_MS)
if ($at -eq -1) { [Console]::Out.WriteLine('EXITED before showing a window'); exit 2 }
if ($at -eq -2) { [Console]::Out.WriteLine('TIMEOUT waiting for a visible window'); exit 3 }
[Console]::Out.WriteLine($at)
`;

export function createWindowsProbe(): ProcessProbe {
  return {
    tree(rootPid) {
      return new Promise((resolve, reject) => {
        execFile(
          POWERSHELL,
          [...PS_ARGS, encoded(treeScript(rootPid))],
          { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout) => {
            if (error) return reject(error);
            const text = stdout.trim();
            if (!text) return resolve([]);
            try {
              resolve(JSON.parse(text) as ProcessSample[]);
            } catch (parseError) {
              reject(new Error(`Unexpected process-tree output: ${text.slice(0, 200)} (${String(parseError)})`));
            }
          },
        );
      });
    },

    createWindowWatcher(timeoutMs) {
      return new Promise((resolveWatcher, rejectWatcher) => {
        const child = spawn(POWERSHELL, [...PS_ARGS, encoded(WATCHER_SCRIPT)], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, KALCODE_PERF_WATCH_TIMEOUT_MS: String(timeoutMs) },
        });
        let buffer = "";
        let ready = false;
        let onResult: ((line: string) => void) | null = null;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!ready && line === "READY") {
              ready = true;
              resolveWatcher(watcher);
            } else if (line && onResult) {
              onResult(line);
            }
            newline = buffer.indexOf("\n");
          }
        });
        child.once("error", rejectWatcher);
        const watcher: WindowWatcher = {
          watch(pid) {
            return new Promise((resolveVisible, rejectVisible) => {
              onResult = (line) => {
                const at = Number(line);
                if (Number.isFinite(at) && at > 0) resolveVisible(at);
                else rejectVisible(new Error(`Window watcher: ${line}`));
              };
              child.stdin.write(`${pid}\n`);
            });
          },
          dispose() {
            if (child.exitCode === null) child.kill();
          },
        };
      });
    },

    requestClose(pid) {
      // Without /F, taskkill posts WM_CLOSE: the same path as clicking the window's close button.
      execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    },

    forceKill(pid) {
      try {
        execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      } catch {
        // Already gone.
      }
    },
  };
}
