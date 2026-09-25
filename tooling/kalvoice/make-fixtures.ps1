# Generates KalVoice latency-benchmark fixtures with the local Windows voice (System.Speech).
# Provenance: synthesized text-to-speech only; no recorded human audio. 16 kHz, 16-bit, mono WAV.
# Usage: powershell -File tooling/kalvoice/make-fixtures.ps1 -Out <folder>
param([Parameter(Mandatory = $true)][string]$Out)
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $Out | Out-Null
$phrases = [ordered]@{
  "open-dashboard"        = "Open Dashboard."
  "open-four-codex"       = "Open four Codex threads."
  "whats-waiting"         = "Show what's waiting for me."
  "open-auth-workspace"   = "Open the authentication workspace."
  "split-claude-codex"    = "Split Claude and Codex side by side."
  "long-dictation"        = "Refactor the login handler so it validates the token before reading the session, then add a unit test for the expired token case."
}
$rates = @{ "normal" = 0; "fast" = 4; "slow" = -4 }
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($name in $phrases.Keys) {
  foreach ($rate in $rates.Keys) {
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.Rate = $rates[$rate]
    $s.SetOutputToWaveFile((Join-Path $Out "$name-$rate.wav"), $format)
    $s.Speak($phrases[$name])
    $s.Dispose()
  }
}
$phrases | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Out "phrases.json")
Write-Output "Wrote $($phrases.Count * $rates.Count) fixtures to $Out"
