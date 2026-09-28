# Latency fixtures for the KalVoice baseline: tooling/kalvoice/make-fixtures.ps1 phrases plus the
# owner paraphrase examples (normal rate). Synthesized locally with System.Speech; no human audio.
# Usage: powershell -File make-fixtures-plus.ps1 -Out <folder>; then trim-at-speech-end.ps1 for the
# "release the key as speech ends" variant.
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
  "para-back-to-settings" = "Can you take me back to settings?"
  "para-agents-doing"     = "Show me what all my agents are doing."
  "para-browser"          = "Take me to the browser."
  "para-provider-waiting" = "Which provider is waiting on me?"
  "para-pause-running"    = "Pause everything that's currently running."
  "para-needs-permission" = "Show me anything that needs permission."
}
$rates = @{ "normal" = 0; "fast" = 4; "slow" = -4 }
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($name in $phrases.Keys) {
  foreach ($rate in $rates.Keys) {
    if ($name.StartsWith("para-") -and $rate -ne "normal") { continue }
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.Rate = $rates[$rate]
    $s.SetOutputToWaveFile((Join-Path $Out "$name-$rate.wav"), $format)
    $s.Speak($phrases[$name])
    $s.Dispose()
  }
}
Write-Output "done"
