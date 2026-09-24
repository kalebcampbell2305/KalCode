import type { SurfaceId } from "@kalcode/protocol";
import { Badge } from "@kalcode/ui/components";
import jarvisGlobe300 from "../../assets/brand/jarvis-globe-300.webp";
import jarvisGlobe600 from "../../assets/brand/jarvis-globe-600.webp";
import { JarvisTagline, JarvisWordmark } from "../../shell/Brand.tsx";
import { SURFACES } from "../../shell/navigation.tsx";
import { Page } from "../../shell/Page.tsx";
import styles from "./GatedSurface.module.css";

/**
 * Honest status page for a surface that hasn't shipped. Visible only in development builds;
 * stable builds hide these surfaces entirely.
 */
export function GatedSurface({ id }: { id: SurfaceId }) {
  const meta = SURFACES[id];
  return (
    <Page title={meta.label} width="narrow">
      <div className={styles.body} data-surface={id}>
        {id === "jarvis" ? <JarvisBrand /> : null}
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

/** The JARVIS artwork: its globe and lettering, on the artwork's own dark ground. */
function JarvisBrand() {
  return (
    <figure className={styles.jarvis}>
      <img
        src={jarvisGlobe300}
        srcSet={`${jarvisGlobe300} 300w, ${jarvisGlobe600} 600w`}
        sizes="15rem"
        width={300}
        height={300}
        alt="JARVIS globe: a sphere of connected points of light"
        className={styles.globe}
      />
      <figcaption className={styles.lockup}>
        <JarvisWordmark className={styles.jarvisWordmark} />
        <JarvisTagline className={styles.jarvisTagline} />
      </figcaption>
    </figure>
  );
}
