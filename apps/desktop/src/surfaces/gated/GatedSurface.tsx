import type { SurfaceId } from "@kalcode/protocol";
import kalcodeMascot362 from "../../assets/brand/kalcode-mascot-362.webp";
import kalcodeMascot724 from "../../assets/brand/kalcode-mascot-724.webp";
import kalvoiceGlobe300 from "../../assets/brand/kalvoice-globe-300.webp";
import kalvoiceGlobe600 from "../../assets/brand/kalvoice-globe-600.webp";
import { SURFACES } from "../../shell/navigation.tsx";
import { Page } from "../../shell/Page.tsx";
import styles from "./GatedSurface.module.css";

/**
 * Honest status page for a surface that hasn't shipped. Visible only in development builds;
 * stable builds hide these surfaces entirely. Designed as a framed hero on the brand artwork's
 * ground: what the surface is for, and exactly what it is waiting on.
 */
export function GatedSurface({ id }: { id: SurfaceId }) {
  const meta = SURFACES[id];
  const Icon = meta.icon;
  const voice = id === "kalvoice";
  return (
    <Page title={meta.label}>
      <section className={styles.hero} data-surface={id} aria-labelledby={`gated-${id}-summary`}>
        {/* The lit top edge on an inert element, not ::before (see GatedSurface.module.css). */}
        <span className={styles.heroEdge} aria-hidden="true" />
        <div className={styles.copy}>
          <div className={styles.head}>
            <span className={styles.iconTile} aria-hidden="true">
              <Icon />
            </span>
            <p className={styles.eyebrow}>{voice ? "KalVoice · preview" : "In development"}</p>
          </div>
          {voice ? <p className={styles.voiceName}>KalVoice</p> : null}
          <p id={`gated-${id}-summary`} className={styles.summary}>
            {meta.summary}
          </p>
          <dl className={styles.spec}>
            <div className={styles.specRow}>
              <dt>Availability</dt>
              <dd>
                <span className={styles.pill}>Not available in this build</span>
              </dd>
            </div>
            {meta.dependsOn ? (
              <div className={styles.specRow}>
                <dt>Builds on</dt>
                <dd>{meta.dependsOn}</dd>
              </div>
            ) : null}
            <div className={styles.specRow}>
              <dt>Status</dt>
              <dd>Nothing on this page runs yet.</dd>
            </div>
          </dl>
        </div>
        <figure className={styles.art}>
          {voice ? (
            <img
              src={kalvoiceGlobe300}
              srcSet={`${kalvoiceGlobe300} 300w, ${kalvoiceGlobe600} 600w`}
              sizes="15rem"
              width={300}
              height={300}
              alt="KalVoice globe: a sphere of connected points of light"
              className={styles.globe}
            />
          ) : (
            <img
              src={kalcodeMascot362}
              srcSet={`${kalcodeMascot362} 362w, ${kalcodeMascot724} 724w`}
              sizes="15rem"
              width={362}
              height={362}
              alt=""
              className={styles.mascot}
            />
          )}
        </figure>
      </section>
    </Page>
  );
}
