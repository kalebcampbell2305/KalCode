# Copies 16 kHz mono 16-bit WAV fixtures, cutting each at the end of its last voiced 30 ms window
# (RMS >= 0.012, the streamer's tail-silence threshold). latency_bench releases the key 30 ms after
# the WAV ends, so trimmed fixtures model "speak, then release immediately" instead of the TTS
# file's ~0.5 s trailing silence (which lets the streamer reuse its last partial).
# Usage: powershell -File trim-at-speech-end.ps1 -In <fixtures> -Out <trimmed>
param([Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out)
New-Item -ItemType Directory -Force $Out | Out-Null
foreach ($file in Get-ChildItem $In -Filter *.wav) {
  $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
  $pos = 12; $dataAt = -1; $dataLen = 0
  while ($pos + 8 -le $bytes.Length) {
    $id = [System.Text.Encoding]::ASCII.GetString($bytes, $pos, 4)
    $len = [BitConverter]::ToInt32($bytes, $pos + 4)
    if ($id -eq "data") { $dataAt = $pos + 8; $dataLen = $len; break }
    $pos += 8 + $len + ($len % 2)
  }
  if ($dataAt -lt 0) { throw "no data chunk in $($file.Name)" }
  $samples = [int]($dataLen / 2); $window = 480; $last = 0
  for ($i = 0; $i -lt $samples; $i += $window) {
    $n = [Math]::Min($window, $samples - $i); $sum = 0.0
    for ($j = 0; $j -lt $n; $j++) { $v = [BitConverter]::ToInt16($bytes, $dataAt + 2 * ($i + $j)) / 32768.0; $sum += $v * $v }
    if ([Math]::Sqrt($sum / $n) -ge 0.012) { $last = $i + $n }
  }
  $keep = 2 * $last
  $buffer = New-Object byte[] ($dataAt + $keep)
  [Array]::Copy($bytes, 0, $buffer, 0, $dataAt + $keep)
  [BitConverter]::GetBytes([int]($dataAt + $keep - 8)).CopyTo($buffer, 4)
  [BitConverter]::GetBytes([int]$keep).CopyTo($buffer, $dataAt - 4)
  [System.IO.File]::WriteAllBytes((Join-Path $Out $file.Name), $buffer)
}
Write-Output "trimmed fixtures written to $Out"
