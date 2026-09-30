# Copy sheet — approved on-screen text

Rules: sentence case, no exclamation marks, no ALL-CAPS marketing lines, headlines ≥ 72 px at
1080p, supporting copy ≥ 34 px, and each line held for at least 1 s after it has fully
landed. Claims are traced to `product_truth.md` (T#). Status words, button labels and UI
strings are quoted verbatim from the app. The source is `src/data/copy.ts`.

| Time | Line | Size (1080p) | Type | Truth |
|---|---|---|---|---|
| 2.0 | Too many windows. | 120 | headline | framing (no claim) |
| 3.5 | Too much context switching. | 52 | support | framing |
| 6.5 | Introducing KalCode. | 124 | headline | T1 |
| 8.0 | One cockpit for AI software development. | 50 | support | positioning (see truth doc) |
| 11.0 | Your project. | 76 | lower third | T6 |
| 12.0 | Your terminals. | 76 | lower third | T7 |
| 13.0 | Your browser. | 76 | lower third | T7 |
| 14.0 | Your agents. | 76 | lower third | T8 |
| 17.0 | Claude Code. Codex. Every account. | 76 | lower third | T8, T9 |
| 20.5 | Switch accounts. Keep going. | 76 | lower third | T10, T11 (manual switch, shown) |
| 25.0 | Different tasks. | 76 | lower third | T12 |
| 26.0 | Same project. | 76 | lower third | T12, T13 |
| 28.0 | Parallel. | 230 | hero word | T12 (four working at once, shown) |
| 34.0 | Say the task. | 84 | headline | T16, T17 |
| 35.0 | KalVoice. | 84 | headline | T16 |
| 35.0 | Hold F8. Speech stays on your device. | 36 | caption | T16, T18 |
| 40.0 | Build it. | 84 | headline | T7 |
| 41.0 | See it. | 84 | headline | T7 |
| 43.0 / 45.0 / 48.0 | Build. / Test. / Ship. | 120 | headline, one word at a time | T19–T22 (gated release shown) |
| 51.0 | Build KalCode. | 96 | headline | T25 (story) |
| 52.0 | Inside KalCode. | 96 | headline | T25 (story) |
| 56.0 | One intelligence. A brighter tomorrow. | 40 | tagline | T2 |
| 57.0 | Download KalCode | 34 (button) | CTA | T24 |
| 57.0 | Start on Free. Upgrade any time. | 36 | support | T24 |
| 57.5 | kalcoded.com | 56 | URL | T24 |
| 57.5 | Windows · macOS (Apple silicon) | 34 | support | T24 |

**Persistent small label:** "Sample project data", 14 px, bottom right, on every product-UI shot.

## Rejected lines (and why)

- "More accounts. More parallel work." — implies account switching increases throughput automatically; replaced with the manual truth.
- "Run six agents." — Stable runs 4 working turns at once.
- "Start free." — not live wording; "Start on Free. Upgrade any time." is.
- "Update available." — the app never says it.
- "The future of coding.", "Revolutionary", "10x" — prohibited by the brief.
