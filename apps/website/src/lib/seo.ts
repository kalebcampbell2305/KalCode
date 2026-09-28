/**
 * Structured data (schema.org JSON-LD) for the home page. Built only from the site's own sources
 * of truth: SOCIAL for profiles, the plan catalog for offers, the release manifest for operating
 * systems. No ratings or reviews: there are none to report.
 *
 * The JSON-LD block is a non-executing data block (`type="application/ld+json"`), which the
 * Worker's CSP `script-src` does not govern, so it needs no hash.
 */
import { PLANS } from "@kalcode/protocol/plans";
import { OS_NAMES, RELEASES, type ReleaseManifest } from "./releases";
import { CONTACT_EMAIL, SITE_NAME, SITE_ORIGIN, SOCIAL } from "./site";

export const TWITTER_SITE = SOCIAL.official.handle;

export function structuredData(manifest: ReleaseManifest = RELEASES): Record<string, unknown> {
  const organizationId = `${SITE_ORIGIN}/#organization`;
  const operatingSystems = manifest.latest?.platforms.map((platform) => OS_NAMES[platform.os]) ?? [];
  const application: Record<string, unknown> = {
    "@type": "SoftwareApplication",
    "@id": `${SITE_ORIGIN}/#software`,
    name: SITE_NAME,
    url: `${SITE_ORIGIN}/`,
    applicationCategory: "DeveloperApplication",
    description:
      "A desktop workspace that connects the coding agents you already use — Claude Code and Codex — on your own accounts.",
    publisher: { "@id": organizationId },
    offers: PLANS.map((plan) => ({
      "@type": "Offer",
      name: plan.name,
      price: plan.price.amountUsd.toFixed(2),
      priceCurrency: "USD",
      url: `${SITE_ORIGIN}/pricing`,
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: plan.price.amountUsd.toFixed(2),
        priceCurrency: "USD",
        billingDuration: "P1M",
        unitText: "MONTH",
      },
    })),
  };
  if (operatingSystems.length > 0) {
    application.operatingSystem = operatingSystems.join(", ");
    application.softwareVersion = manifest.latest?.version;
    application.downloadUrl = `${SITE_ORIGIN}/download`;
  }

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: SITE_NAME,
        url: `${SITE_ORIGIN}/`,
        logo: `${SITE_ORIGIN}/assets/brand/kalcode-mark-256.png`,
        email: CONTACT_EMAIL,
        // The product's own profile only; the founder's personal account is not the organization.
        sameAs: [SOCIAL.official.url],
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_ORIGIN}/#website`,
        name: SITE_NAME,
        url: `${SITE_ORIGIN}/`,
        publisher: { "@id": organizationId },
      },
      application,
    ],
  };
}

/** Serialises JSON-LD for an HTML data block: `<` is escaped so the text can never close the tag. */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
