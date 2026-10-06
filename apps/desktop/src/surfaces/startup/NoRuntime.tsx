import { ErrorState } from "@kalcode/ui/components";
import { Lockup } from "../../shell/Brand.tsx";
import styles from "./Startup.module.css";

/** Rendered when the UI is opened outside the desktop app (e.g. in a plain browser). */
export function NoRuntime() {
  return (
    <main className={styles.screen}>
      <div className={styles.panel}>
        {/* The lit top edge on an inert element, not ::before (see Startup.module.css). */}
        <span className={styles.panelEdge} aria-hidden="true" />
        <Lockup className={styles.lockup} />
        <ErrorState headingLevel={1} title="Open KalCode from the desktop app">
          <p>
            This interface needs KalCode's native runtime, which only runs inside the desktop app. Start it with{" "}
            <code>pnpm dev:desktop</code> from the repository root.
          </p>
        </ErrorState>
      </div>
    </main>
  );
}
