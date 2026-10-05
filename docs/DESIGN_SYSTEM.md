# KalCode Design System

Source: `packages/ui` (`@kalcode/ui`). Consumed by the desktop app and the website, so both read as
one product family.

## Principles

- **Desktop visuals must earn their place.** Every technical element conveys actual state,
  enables an action, improves navigation, or supports the KalCode brand without distracting
  from work. No decorative node networks, fake graphs, random sparklines, fabricated analytics,
  or placeholder technical art. Charts require a real, identified data source; unavailable
  telemetry stays unavailable. The Dashboard's true empty state is plain guidance with a
  New Session action (plus Open Code where provider panes exist), without an illustration; when
  every session is archived it says so and offers them read-only. This rule applies throughout
  the desktop app; the marketing website may retain its cinematic brand treatment.
- **Dark, polished, cinematic, technical.** A near-black graphite foundation (low chroma, never
  navy), graphite panels, fine hairlines, bright type and one electric-blue accent used sparingly.
  The brand artwork is the one bold element; the product UI is composed of framed panels with quiet
  sheen, not of cards, gradients or glow for their own sake.
- **A restrained deep-space atmosphere.** A faint star field over two blue washes
  (`--atmosphere-*`) sits behind the shell and inside empty-state wells. Panels are opaque on top
  of it, so it never lowers text contrast; light keeps only the wash; high contrast removes it.
- **Provider identity stays small.** Provider colours (`--provider-*`) appear only in glyphs,
  badges and a pane's identity stripe. KalCode's accent and hierarchy own every surface.
- **Glow is a signal, not decoration.** The blue-lit hairline (`--color-border-lit*`,
  `--shadow-lit`) marks the one active or focused surface (the selected nav item, the lit pane, the
  command palette, the selected row). Dense UI never gets the website's button halo.
- **Dense and functional.** The app is denser than the website: 13 px UI text, 32–40 px rows,
  compact panel headers. Display type is reserved for the website, empty states and the boot/home
  moments.
- **Nothing bland, empty or unfinished.** Every empty state is a designed well (what this place is
  for + the next step); every error is framed, says what failed and what is safe.
- **Every appearance mode is designed, never inverted.** Dark is the flagship; light is navy ink
  on cool paper; high contrast (per theme) lifts text to AAA (7:1), strengthens hairlines, focus,
  selection and lit states, and removes sheen, glow and atmosphere. Every text token meets its
  bar on every surface of its mode: `designTokens.test.ts` computes it from the tokens, and axe
  checks the rendered app in both themes.
- **Accessibility is a first-class quality bar.** Keyboard focus is always visible (token ring,
  thicker in high contrast; system `Highlight` under Windows forced colours). Reduced motion
  removes loops and zeroes durations. Text size (Default / Large / Larger) scales the whole
  rem-based UI and terminal text together.
- **Enforced, not suggested.** UI stylesheets (`apps/desktop/src`, `packages/ui/src/components`)
  contain no colour literals (pure black/white alpha excepted), no literal `var()` fallbacks, no
  `px` font sizes, no off-scale radii, and no custom property that nothing defines.
  `apps/desktop/src/designTokens.test.ts` fails the build otherwise.
- **Status is never colour alone** — always tone + glyph + words.

## Tokens (`src/styles/tokens.css`, `src/styles/terminal.css`)

Existing values the website relies on are stable; Z7-W0 added tokens rather than re-tinting old
ones. Legacy `--color-live/-waiting/-success/-danger/-idle` keep their values (the website stage
uses amber `--color-waiting` for Paused); **new status UI uses `--status-*`.**

| Group | Tokens | Notes |
| --- | --- | --- |
| Palette | `--color-bg` Graphite `#08090C`, `--color-surface` Hull `#0F1115`, `--color-accent` Constellation `#4C8DFF`, `--color-accent-icy`, `--color-text*` (Starlight `#EEF1F6`) | Graphite surfaces stay low-chroma (a test caps channel spread). Accent sparingly: focus, the active item, primary buttons, live data lines. |
| Elevation | `--color-bg-sunken` < `--color-bg` < `--color-surface-1` (panel) < `--color-surface-2` (header / input well) < `--color-surface-3` (popover) | Text tokens keep ≥ 4.5:1 on all steps. |
| Hairlines | `--color-border-subtle`, `--color-border`, `--color-border-strong`, `--color-border-lit-soft`, `--color-border-lit`, `--color-border-focus` | Lit = active/focused only. |
| Panel | `--panel-sheen` (top highlight gradient), `--panel-px/-py`, `--panel-header-h`, `--panel-gap`, `--radius-panel` | `background: var(--panel-sheen), var(--color-surface-1)`. |
| Shadows | `--shadow-sm/-md/-lg`, `--shadow-panel`, `--shadow-lit`, `--shadow-xl` (floating), `--shadow-well` (inset) | |
| Atmosphere | `--atmosphere-stars` + `--atmosphere-stars-size` (tiled star field; `none` in light and high contrast), `--atmosphere-glow` (two blue washes), `--app-backdrop` (= the glow, for surfaces that paint their own backdrop) | Shell frame and empty-state wells: `background: var(--atmosphere-stars) 0 0 / var(--atmosphere-stars-size), var(--atmosphere-glow), var(--color-bg)`. |
| Focus | `--focus-ring-width` (2 px; 3 in high contrast), `--focus-ring-offset`, `--focus-ring-color`, `--shadow-focus` | `:focus-visible` everywhere uses these. |
| Chart | `--chart-1..5`, `--chart-grid`, `--chart-track`, `--chart-axis`, `--chart-area` | Series 1 is the accent; never status by colour alone. |
| Loading · Empty · Error | `--skeleton-base/-highlight`, `--dur-shimmer`; `--empty-well-bg/-border`; `--error-surface/-line/-text` | Consumed by `Skeleton`, `EmptyState`, `ErrorState`. |
| Status (contract `StatusTone`) | `--status-{working,waiting,muted,done,failed,paused,recovering}` + `-soft`, `-text`, `-line` | Owner language: **blue = active/focused · green = healthy/running · amber = waiting for you · red = error/failure**. working green · waiting/permission amber · muted · done high-contrast neutral · failed red · paused amber · recovering blue. The focused terminal pane plays one blue edge trace, then keeps a thin blue outline; unfocused panes stay neutral. `-text` is AA on every surface. |
| Primary button | `--btn-primary-{bg,top,bottom,fg,edge,glow}` | Deep constellation blue, white label ≥ 4.5:1. |
| Type roles | `--type-display`, `--type-headline`, `--type-title`, `--type-body`, `--type-ui`, `--type-small`, `--type-label`, `--type-mono`, `--type-kpi` (+ `-weight`, `-tracking`), `--font-display`, `--font-label`, `--tracking-label` | One family, Lexend (Deca for UI; Exa/Giga for the wordmark and website display), JetBrains Mono for code. The website overrides the role *sizes* with its marketing scale; the roles are shared. |
| Space | 4 px base; `--space-2-5`, `--space-3-5`, `--space-7` added; `--row-h`, `--row-h-dense` | `[data-density="compact"]` tightens controls, rows and panels. |
| Radius | `--radius-xs` 3 … `--radius-2xl` 18, `--radius-control`, `--radius-panel`, `--radius-card` (10), `--radius-floating` (14) | Small for controls; 10 for panels, cards and menus; 14 for dialogs and the command palette. |
| Motion | `--dur-*`, `--ease-out/-in-out/-expo`, `--ease-standard`, `--ease-emphasized`, `--dur-status` (one-shot change highlight), `--dur-pulse` (working breathe), `--dur-shimmer` (loading sweep) | Durations collapse to 0 under reduced motion (`[data-motion="reduced"]` or the OS preference); loops are removed entirely. No bounce. |
| Terminal (`terminal.css`) | `--term-*` ANSI palette per theme, `--provider-*` accents | One source for the website stage and the desktop xterm theme (`apps/desktop/src/surfaces/code/terminalTheme.ts`, kept identical by a unit test). Every foreground ≥ 4.5:1 on `--term-bg`; xterm keeps `minimumContrastRatio: 4.5`. Provider accents identify; they never carry status. |

### Type roles

| Role | Use | App size |
| --- | --- | --- |
| DISPLAY | home greeting, boot, large empty wells | 28 px semibold, −0.03em |
| HEADLINE | page / surface title | 20 px semibold, −0.02em |
| TITLE | panel, card and dialog titles | 14 px semibold |
| BODY | running text | 14 px |
| UI | controls, rows, table cells | 13 px |
| LABEL | eyebrows, column heads, chip text, section labels | 11 px medium, uppercase, 0.08em |
| MONO | commands, paths, IDs, terminal-adjacent text | 12.5 px JetBrains Mono |
| KPI | stat values | 26 px medium, tabular figures |

## Components (`src/components`)

Accessible behaviour comes from Radix UI; styling is tokens only.

| Component | Since | API notes |
| --- | --- | --- |
| `Button`, `IconButton` | Z0, reskinned W0 | `variant`: primary (deep blue, lit top edge, faint glow on hover only) · secondary (raised hairline; hairline lights on hover) · ghost · danger. `size` sm/md/lg, `busy`, `icon`. |
| `StatusChip` | W0 | `status?: DisplayStatus` (derives tone, glyph, words) · `tone?: StatusTone` · `label?` · `qualifier?` (contract qualifier or text) · `icon?` (`null` = dot) · `variant`: chip (caps, bordered) / inline (glyph + words) / dot · `size` sm/md. WORKING breathes, STARTING/RECOVERING turn slowly, a status change gets a one-shot highlight; reduced motion removes all. Exports `DISPLAY_STATUS_TEXT`, `DISPLAY_STATUS_GLYPH`. |
| `StatusIndicator` | Z0, extended W0 | Dot + words. `tone` accepts contract tones or legacy (`live` → blue, `success` → green, `waiting` → neutral, `danger` → red, `idle` → muted). |
| `Badge` | Z0, reskinned W0 | `tone`: neutral · accent · success · waiting (neutral) · paused (amber) · danger · outline. |
| `ProviderMark`, `ProviderGlyph`, `providerIdentity` | W0 | KalCode-drawn glyph (never a provider logo; same shapes as the website stage) + provider name in plain text (ADVANCED §17). `provider` id, `name?`, `detail?` (model), `tile?`, `size` xs/sm/md/lg, `tone` accent/neutral, `hideName?`. Unknown ids get a lettered hexagon. |
| `Panel`, `Surface`, `Eyebrow` | W0 | Panel: `title`, `eyebrow`, `icon`, `count` + `countTone`, `actions`, `description`, `footer`, `tone` default/lit/flush, `padding` none/sm/md, `as`, `id` (labels the region). Surface: `level` 1–3, `lit`, `interactive`, `sunken`. |
| `Stat`, `StatGroup`, `Sparkline` | W0 | KPI tile: `label`, `value`, `icon`, `tone`, `hint`, `trend`, `quiet`, `onSelect` + `selected` (renders a toggle button for filters). Sparkline: `values`, `tone`, `variant` line/bars (decorative, `aria-hidden`). |
| `Table`, `RowList`, `RowItem` | W0 | Native table with LABEL-role heads, hairline rows, `dense`, `stickyHeader`, `framed`, `caption`/`captionHidden`; `tr[data-selected]`, `[data-numeric]`. RowList (`label` required) / RowItem (`selected`, `interactive`). |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | W0 | Radix tabs; `TabsList variant`: line (lit underline) / pill. |
| `PermissionPrompt` | Z4, reskinned W0 | Waiting is amber (emphasized rail + shield + words), approved green, denied/expired muted. Options render in the caller's order; the app's order is **Deny · Allow for workspace · Allow for thread · Approve once**. |
| `EmptyState` | Z0, redesigned W0 | Framed well by default (sunken surface, faint constellation field); `art` on a lit tile (`artStyle="free"` for illustrations); `framed={false}` inside a Panel; `align` start/center. |
| `ErrorState` | Z0, redesigned W0 | Framed with the failed hairline and glyph; `code` in mono; `framed={false}` available. |
| `Skeleton`, `Section`, `KeyValueList`, `Kbd`, `SegmentedControl`, `Tooltip`, `ToastProvider`/`useToast`, `DropdownMenu*`, `Field`/`TextInput`/`TextArea`/`Select`, `DiffView` | Z0–Z6 | Reskinned in W0: floating layers on `--color-surface-3` with `--shadow-xl` and a strong hairline; inputs are sunken wells with a lit focus ring; menu labels use the LABEL role. |

## Appearance modes

Applied to `<html>` by `apps/desktop/src/shell/appearance.ts` from Settings → Appearance (also in
the command palette). "System" choices are resolved against the OS there, so CSS reads one answer.

| Attribute | Values | Setting |
| --- | --- | --- |
| `data-theme` | `dark` · `light` | Theme: System / Light / Dark |
| `data-contrast` | `standard` · `more` | Contrast: System (`prefers-contrast: more`) / Standard / High |
| `data-text-size` | unset · `large` (112.5%) · `larger` (125%) | Text size: Default / Large / Larger. Terminals follow (13 → 15 → 16 px) |
| `data-motion` | unset (OS) · `reduced` · `full` | Motion |
| `data-density` | `comfortable` · `compact` | Density |

`@media (forced-colors: active)` (Windows High Contrast) keeps focus, selection and current items
visible with system colours (`base.css`).

## Using the system

- Compose surfaces from `Panel` (or `Surface`) — do not hand-roll borders, shadows or backgrounds.
- Show a thread/pane status with `StatusChip status={displayStatusOf(s).status}`; never map colours
  yourself. Provider identity is `ProviderMark` everywhere a provider is named.
- Use `--status-*` tokens for any status colour; `--color-waiting` (amber) is legacy/caution only.
- Light exactly one thing with `tone="lit"` / `lit` / `--shadow-lit` at a time.
- Numbers use tabular figures (`Stat`, `Table`); commands and paths use `--font-mono`.
- Full-window: no surface-level max-width; only prose keeps `--prose-max`.
- Loading is `Skeleton` (`--skeleton-*`, `--dur-shimmer`); empty is `EmptyState` (`--empty-*`,
  the star-field well); errors are `ErrorState` (`--error-*`). Never a blank area or bare text.
- Charts take series colours from `--chart-1..5` (series 1 is the accent), gridlines from
  `--chart-grid`, axes from `--chart-axis`; a label or legend always names a series.
- Corner radii come from the scale: controls `--radius-control`, cards, wells and menus
  `--radius-card` (10), dialogs and the command palette `--radius-floating` (14).
- Size text with type tokens (`--type-*`, `--text-*`) or `rem`, never `px`.

## Brand

See `docs/BRAND.md`. Brand imagery is always derived from the owner's artwork.
