/**
 * Where a Z7-W2 surface (Home, the project page, the workspace list) is shown: as the page, or
 * inside a pane of the Code canvas (Z7-W1 pane system). A page owns the window's single `h1`
 * and fixed region ids; inside a pane the tab labels the panel, so headings step down one level
 * and ids get a suffix that can't collide with the page's.
 */
import { createContext, type ReactNode, useContext, useId, useMemo } from "react";

/** Levels a surface uses on the page. */
export type HeadingLevel = 1 | 2 | 3;
/** The same heading on the page or one level lower in a pane. */
export type ScopedLevel<L extends HeadingLevel> = L extends 1 ? 1 | 2 : L extends 2 ? 2 | 3 : 3 | 4;

export interface SurfaceScope {
  inPane: boolean;
  /** The heading level for a heading that is `level` on the page. */
  level: <L extends HeadingLevel>(level: L) => ScopedLevel<L>;
  /** A DOM id unique to where the surface is shown. */
  id: (name: string) => string;
}

const PAGE: SurfaceScope = {
  inPane: false,
  level: <L extends HeadingLevel>(l: L) => l as unknown as ScopedLevel<L>,
  id: (name) => name,
};

const SurfaceScopeContext = createContext<SurfaceScope>(PAGE);

/** Shows its children as pane content (see the module comment). */
export function InPane({ children }: { children: ReactNode }) {
  // Unique per pane: the same surface may be in two panes (two workspaces' Git panes).
  const suffix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const scope = useMemo<SurfaceScope>(
    () => ({
      inPane: true,
      level: <L extends HeadingLevel>(l: L) => (l + 1) as ScopedLevel<L>,
      id: (name) => `${name}-pane-${suffix}`,
    }),
    [suffix],
  );
  return <SurfaceScopeContext.Provider value={scope}>{children}</SurfaceScopeContext.Provider>;
}

export function useSurfaceScope(): SurfaceScope {
  return useContext(SurfaceScopeContext);
}

/** A heading at `level` on the page, one lower in a pane. */
export function ScopedHeading({
  level,
  className,
  id,
  children,
}: {
  level: HeadingLevel;
  className?: string;
  id?: string;
  children: ReactNode;
}) {
  const scope = useSurfaceScope();
  const Tag = `h${scope.level(level)}` as const;
  return (
    <Tag className={className} id={id}>
      {children}
    </Tag>
  );
}
