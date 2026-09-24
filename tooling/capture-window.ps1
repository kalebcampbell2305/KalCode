# Captures a top-level window (by title) to a PNG, including WebView2 content, for visual QA.
# Usage: powershell -File tooling/capture-window.ps1 [-Process kalcode] -Out shot.png
param(
  [string]$Process = "kalcode",
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KcWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

[KcWin]::SetProcessDPIAware() | Out-Null
$proc = Get-Process -Name $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $proc) { Write-Error "No visible window for process '$Process'"; exit 1 }
$handle = $proc.MainWindowHandle
$rect = New-Object KcWin+RECT
[KcWin]::GetWindowRect($handle, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
# 2 = PW_RENDERFULLCONTENT: captures GPU-composited WebView2 content.
[KcWin]::PrintWindow($handle, $hdc, 2) | Out-Null
$graphics.ReleaseHdc($hdc)
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose()
Write-Output "captured ${width}x${height} -> $Out"
