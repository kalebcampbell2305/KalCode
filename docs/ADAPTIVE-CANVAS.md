# Adaptive Canvas

Code's Layout menu offers Build, Debug, Review, Ship and Focus. These are explicit layout actions. Context suggestions never apply themselves, and resizing the window never rearranges the user's panes.

Build brings existing coding agents, Browser and terminals together. Debug adds the live Activity event log and Browser; Ship adds Activity beside terminal work. Review gives existing comparison work equal space. Focus maximizes the selected pane without discarding the surrounding layout. Unavailable Git or diff capabilities are never opened as if they exist; registered pane contents participate in the same canvas.

Tidy balances occupied panes without stopping a terminal or agent. Undo Tidy restores the exact prior tree, ratios, selected tabs, maximization and focus. Task layouts also have one-step undo. A subsequent layout edit invalidates that checkpoint so Undo cannot remove newly opened work or resurrect closed sessions. Terminal cleanup remains a separate, explicitly named KalTidy action.

Drag tabs or pane headers toward an edge to snap, or to the center to combine tabs. A magnetic band stabilizes the target; the placement preview uses the proposed layout's actual geometry. Divider handles support pointer dragging and keyboard resizing. Panes retain at least 320 × 220 pixels of working area, with scrolling when necessary instead of unreadable tiles.

Keyboard controls (Control + Alt on Windows; Control + Option on macOS):

- Arrows: focus a neighboring pane.
- Shift + H/J/K/L: move the focused pane left/down/up/right.
- Shift + arrows: resize.
- T: Tidy; Z: undo the latest Tidy or task layout.
- Enter: maximize/restore; H: minimize/expand.
- D: split right; Shift + D: split down.

The native per-workspace layout store retains the tree, ratios, selected tabs and dock. Focus uses a per-workspace local preference, validated against the restored pane IDs. Pending saves retain their original workspace/store when switching workspaces. Content hosts keep the same React portal target across placement changes: mounted terminals, agents, Browser and widgets are moved or hidden, never detached as a layout side effect. Unopened saved tabs initialize only when first selected.

Adaptive Canvas is available to every plan once its production build is verified. The roadmap entry remains coming soon until signed update delivery is proven; Mission Control remains separate.
