# Pins and workspace favorites

Use **Add Favorite** in an object's context menu or its star action to keep it in the current workspace's Favorites strip. **Pin globally** keeps a destination in the Pins strip across workspaces. The strip appears only when it has saved destinations.

Supported destinations are workspaces, Threads, coding agents, terminals, files, Browser pages, provider accounts, commands, Runs, and Services. Existing workspace rail pins remain available. A favorite that is also globally pinned appears once; visible favorites are omitted from recent navigation lists.

- Click a destination to restore its exact identity and workspace context. Commands open their named palette action for review; favoriting or opening the shortcut does not execute a command, start a Run, restart a Service, rebind an account, or duplicate a session.
- Drag within a collection to reorder. Keyboard users can focus a destination and press **Alt+Left/Right** (or **Alt+Up/Down**), or use **Move left/right** in its context menu. Order and membership persist across app restarts.
- Missing or inaccessible destinations stay saved and show **Unavailable** with a reason. **Retry** checks again; **Find target** opens search. Removing a favorite changes only the saved shortcut.
- Browser favorites preserve page queries and fragments. Credential-bearing or temporary sign-in URLs cannot be saved. File favorites store a workspace-relative path and resolve a fresh read-only file handle when opened.

Favorites are local navigation metadata. Storage errors are reported; failed writes do not pretend to persist. Live process handles, terminal buffers, conversation contents, and file contents are not stored in favorites.
