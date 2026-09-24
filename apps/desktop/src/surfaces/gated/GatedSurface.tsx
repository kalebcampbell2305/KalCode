import type { SurfaceId } from "@kalcode/protocol";
import { Badge } from "@kalcode/ui/components";
import kalvoiceGlobe300 from "../../assets/brand/kalvoice-globe-300.webp";
import kalvoiceGlobe600 from "../../assets/brand/kalvoice-globe-600.webp";
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
        {id === "kalvoice" ? <KalVoiceBrand /> : null}
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

/** KalVoice identity: the voice artwork's globe with the KalVoice name, on the artwork's ground. */
function KalVoiceBrand() {
  return (
    <figure className={styles.kalvoice}>
      <img
        src={kalvoiceGlobe300}
        srcSet={`${kalvoiceGlobe300} 300w, ${kalvoiceGlobe600} 600w`}
        sizes="11rem"
        width={300}
        height={300}
        alt="KalVoice globe: a sphere of connected points of light"
        className={styles.globe}
      />
      <figcaption className={styles.lockup}>
        <span className={styles.kalvoiceName}>KalVoice</span>
        <span className={styles.kalvoiceLine}>
          Speak your prompts. Control your workspace. Coordinate your coding agents.
        </span>
      </figcaption>
    </figure>
  );
}
