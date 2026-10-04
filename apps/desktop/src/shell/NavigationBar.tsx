import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
} from "@kalcode/ui/components";
import { ArrowLeft, ArrowRight, ChevronRight, History, Search } from "lucide-react";
import { useWorkspaces } from "../runtime/WorkspaceProvider.tsx";
import styles from "./NavigationBar.module.css";
import { destinationMeta, useNavigation } from "./navigation.tsx";
import { useSearchOpen } from "./rail/search/SearchProvider.tsx";
import { IS_MAC, MOD_LABEL } from "./shortcuts.ts";

/** Navigation follows visits and focus, independently of the sessions those visits show. */
export function NavigationBar() {
  const navigation = useNavigation();
  const { active } = useWorkspaces();
  const { setOpen } = useSearchOpen();
  const {
    current,
    navigate,
    history = [],
    historyIndex = 0,
    back,
    forward,
    canGoBack,
    canGoForward,
    restore,
  } = navigation;
  const entry = history[historyIndex];
  const meta = destinationMeta(current);
  return (
    <div className={styles.bar}>
      <div className={styles.controls}>
        <Tooltip content={`Back (${IS_MAC ? "⌘ [" : "Alt ←"})`}>
          <IconButton
            size="sm"
            label="Go back"
            icon={<ArrowLeft />}
            disabled={!canGoBack}
            onClick={() => void back()}
          />
        </Tooltip>
        <Tooltip content={`Forward (${IS_MAC ? "⌘ ]" : "Alt →"})`}>
          <IconButton
            size="sm"
            label="Go forward"
            icon={<ArrowRight />}
            disabled={!canGoForward}
            onClick={() => void forward()}
          />
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" label="Recent navigation" icon={<History />} disabled={history.length < 2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={styles.history}>
            <DropdownMenuLabel>Recent navigation</DropdownMenuLabel>
            {[...history]
              .reverse()
              .slice(0, 20)
              .map((visit) => (
                <DropdownMenuItem key={visit.id} onSelect={() => void restore(visit.id)}>
                  <span className={styles.visit}>
                    <span>{visit.label ?? destinationMeta(visit.destination).label}</span>
                    <small>
                      {destinationMeta(visit.destination).label}
                      {visit.id === entry?.id ? " · Current" : ""}
                    </small>
                  </span>
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <nav aria-label="Breadcrumb" className={styles.breadcrumbs}>
        {active ? (
          <>
            <button type="button" title={active.displayPath} onClick={() => navigate("code")}>
              {active.name}
            </button>
            <ChevronRight aria-hidden="true" />
          </>
        ) : null}
        <span aria-current={!entry?.target ? "page" : undefined}>{meta.label}</span>
        {entry?.target && entry.label ? (
          <>
            <ChevronRight aria-hidden="true" />
            <span aria-current="page" title={entry.label}>
              {entry.label}
            </span>
          </>
        ) : null}
      </nav>
      <button type="button" className={styles.search} onClick={() => setOpen(true)} aria-label="Open quick switcher">
        <Search aria-hidden="true" />
        <span>Go to anything</span>
        <kbd>{MOD_LABEL} K</kbd>
      </button>
    </div>
  );
}
