// KalCode dark-theme tokens, copied verbatim from packages/ui/src/styles/tokens.css
// (":root, [data-theme=dark]"). The film never invents colours outside this set.
export const C = {
  bg: "#05080f", // Space
  bgSunken: "#03050b",
  surface: "#0b1322", // Hull
  surface1: "#09101d",
  surface2: "#0d1627",
  surface3: "#111c31",
  raised: "#101a2d",
  border: "rgba(142,170,220,0.12)",
  borderStrong: "rgba(142,170,220,0.22)",
  borderSubtle: "rgba(142,170,220,0.08)",
  borderLit: "rgba(92,150,255,0.55)",
  borderLitSoft: "rgba(92,150,255,0.26)",
  text: "#e6edf8", // Starlight
  text2: "#a8b4c9",
  muted: "#8593ab", // Nebula
  faint: "#7a879e",
  accent: "#4c8dff", // Constellation
  accentHover: "#6aa1ff",
  accentText: "#8db6ff",
  accentIcy: "#a9c8ff",
  accentSoft: "rgba(76,141,255,0.14)",
  glow: "rgba(76,141,255,0.45)",
  btnTop: "#2f6bec",
  btnBottom: "#2257d6",
  codeBg: "#070c17",
  working: "#3ccf8e",
  workingText: "#62dca4",
  workingSoft: "rgba(60,207,142,0.12)",
  workingLine: "rgba(60,207,142,0.4)",
  waiting: "#c7d1e0",
  paused: "#f2b544",
  pausedText: "#f6c566",
  pausedSoft: "rgba(242,181,68,0.12)",
  pausedLine: "rgba(242,181,68,0.4)",
  failed: "#ef5f6b",
  failedText: "#ff8a93",
  failedSoft: "rgba(239,95,107,0.13)",
  done: "#eef3fb",
  success: "#35c48d",
  idle: "#8593ab",
} as const;

export const R = { xs: 3, sm: 5, md: 7, lg: 10, xl: 14, xxl: 18 } as const;

export const FONT = {
  ui: "Lexend Deca", // desktop UI + website body
  display: "Lexend Deca",
  wide: "Lexend Exa", // letter-spaced labels
  mono: "JetBrains Mono",
} as const;

export const shadowPanel =
  "inset 0 1px 0 rgba(200,220,255,0.035), 0 1px 0 rgba(0,0,0,0.45), 0 18px 40px -26px rgba(0,0,0,0.9)";
export const shadowLit = "0 0 0 1px rgba(92,150,255,0.26), 0 0 28px -10px rgba(76,141,255,0.4)";
export const shadowXl = "0 32px 80px -24px rgba(0,0,0,0.85), 0 0 0 1px rgba(142,170,220,0.22)";
export const panelSheen = "linear-gradient(180deg, rgba(140,175,240,0.045) 0%, rgba(140,175,240,0) 56px)";
