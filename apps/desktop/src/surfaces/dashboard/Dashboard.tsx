import { EmptyState, Section } from "@kalcode/ui/components";
import { Page } from "../../shell/Page.tsx";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { ConstellationArt } from "./ConstellationArt.tsx";
import styles from "./Dashboard.module.css";
import { RuntimeHealth } from "./RuntimeHealth.tsx";

export function Dashboard() {
  return (
    <Page title="Dashboard" description="Everything running in KalCode, as it happens.">
      <div className={styles.layout}>
        <div className={styles.primary}>
          <Section id="threads" title="Threads">
            <EmptyState art={<ConstellationArt />} title="No threads yet" className={styles.threadsEmpty}>
              <p>
                Threads run Claude Code, Codex or Gemini CLI inside your projects. Each one will appear here with its
                provider, current task, status and any approval it's waiting on.
              </p>
              <p>Threads arrive with provider connections in an upcoming build.</p>
            </EmptyState>
          </Section>
          <ActivityFeed />
        </div>
        <aside className={styles.aside} aria-label="Runtime health">
          <RuntimeHealth />
        </aside>
      </div>
    </Page>
  );
}
