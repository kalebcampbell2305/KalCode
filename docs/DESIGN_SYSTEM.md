# KalCode Design System

Source: `packages/ui` (`@kalcode/ui`). Consumed by the desktop app and the website.

## Principles

- The brand artwork is the one bold element. Everything around it is quiet: hierarchy comes
  from type, spacing and hairline rules, not from cards, gradients or glow.
- Operational UI is calm and dense enough to be useful; display type is reserved for the
  website and empty states.
- Light and dark are both designed. Status is never conveyed by colour alone.

## Tokens (`src/styles/tokens.css`)

| Group | Notes |
| --- | --- |
| Colour | Dark: Space `#05080F`, Hull `#0B1322`, Constellation `#4C8DFF`, Starlight `#E6EDF8`, Nebula `#8593AB`. Light: navy ink on cool paper. Status: live, waiting, success, danger, idle (+ soft variants). Every text token meets WCAG AA (4.5:1) on every surface of its theme — verified by axe in CI. |
| Type | One family, Lexend, with width as the expressive axis: Deca (UI), Exa and Giga (display), JetBrains Mono (code only). Operational scale 11–34 px; fluid display scale for the website. |
| Space | 4 px base scale; density-aware control heights and page padding (`[data-density="compact"]`). |
| Radius | 3–14 px: small for controls, larger only for floating layers. |
| Motion | `--dur-*` and `--ease-*`; all durations collapse to 0 under reduced motion (`[data-motion="reduced"]` or the OS preference). No bounce easing. |
| Layers | z-index scale from base to tooltip. |

## Components (`src/components`)

Implemented in Z0: `Button`, `IconButton`, `Badge`, `StatusIndicator`, `SegmentedControl`
(WAI-ARIA radio group: arrow keys move focus and select), `Tooltip`, `ToastProvider`/`useToast`,
`EmptyState`, `ErrorState`, `Skeleton`, `Section`, `KeyValueList`, `Kbd`.

Added in Z1: `DropdownMenu` (`DropdownMenuTrigger`, `…Content`, `…Item` with icon, description
and shortcut, `…RadioGroup`/`…RadioItem`, `…Label`, `…Separator`) — Radix menu behaviour,
non-modal by default so the rest of the app stays in the accessibility tree.

Terminal palettes (Code surface) live with the surface in `apps/desktop/src/surfaces/code/`
and are derived from the tokens; see `docs/CODE_MODE.md` §6.
Accessible behaviour comes from Radix UI; styling is tokens only.

Planned as surfaces need them: `Input`, `Textarea`, `Select`, `ContextMenu`,
`Dialog`, `Sheet`, `Tabs`, `Table`, `PermissionPrompt`.

## Brand

See `docs/BRAND.md`. Brand imagery is always derived from the owner's artwork.
