import type { SurfaceId } from "@kalcode/protocol";
import { Badge } from "@kalcode/ui/components";
import { SURFACES } from "../../shell/navigation.tsx";
import { Page } from "../../shell/Page.tsx";
import styles from "./GatedSurface.module.css";
import jarvisGlobe from "./jarvis-globe.webp";

/**
 * Honest status page for a surface that hasn't shipped. Visible only in development builds;
 * stable builds hide these surfaces entirely.
 */
export function GatedSurface({ id }: { id: SurfaceId }) {
  const meta = SURFACES[id];
  const isJarvis = id === "jarvis";
  return (
    <Page title={meta.label} width="narrow">
      <div className={styles.body} data-surface={id}>
        {isJarvis ? (
          <figure className={styles.jarvis}>
            <img src={jarvisGlobe} alt="" width={320} height={320} className={styles.globe} />
            <figcaption className={styles.tagline}>Global thinking. Personal impact.</figcaption>
          </figure>
        ) : null}
        <Badge tone="outline">Not available in this build</Badge>
        <p className={styles.summary}>{meta.summary}</p>
        {meta.dependsOn ? (
          <p className={styles.depends}>
            Builds on: <span>{meta.dependsOn}</span>. Nothing on this page runs yet.
          </p>
        ) : null}
      </div>
    </Page>
  );
}
