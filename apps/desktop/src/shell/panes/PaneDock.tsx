import type { PaneContent } from "@kalcode/protocol";
import { IconButton } from "@kalcode/ui/components";
import { X } from "lucide-react";
import type { CSSProperties } from "react";
import type { TabInfo } from "./contentRegistry.ts";
import { contentKey } from "./model.ts";
import styles from "./PaneCanvas.module.css";

interface PaneDockProps {
  items: { content: PaneContent; info: TabInfo }[];
  style: CSSProperties;
  onOpen: (index: number) => void;
  onRemove: (index: number) => void;
}

/**
 * The side dock: things moved out of the canvas but kept at hand (pane menu, "Move to the
 * dock"). Each opens back into the focused pane. Docked content keeps running.
 */
export function PaneDock({ items, style, onOpen, onRemove }: PaneDockProps) {
  return (
    <aside className={styles.dock} style={style} aria-label="Dock">
      <h2 className={styles.dockTitle}>
        Dock <span className={styles.dockCount}>{items.length}</span>
      </h2>
      <ul className={styles.dockList}>
        {items.map(({ content, info }, i) => (
          <li key={contentKey(content)} className={styles.dockItem}>
            <button
              type="button"
              className={styles.dockOpen}
              title={info.statusText ? `${info.title} — ${info.statusText}` : info.title}
              onClick={() => onOpen(i)}
            >
              <span className={styles.tabGlyph} aria-hidden="true">
                {info.glyph}
              </span>
              <span className={styles.dockLabel}>{`Open ${info.title}`}</span>
              {info.tone ? <span className={styles.dot} data-tone={info.tone} aria-hidden="true" /> : null}
            </button>
            <IconButton
              size="sm"
              label={`Remove ${info.title} from the dock`}
              icon={<X />}
              onClick={() => onRemove(i)}
            />
          </li>
        ))}
      </ul>
      <p className={styles.dockNote}>Docked items keep running.</p>
    </aside>
  );
}
