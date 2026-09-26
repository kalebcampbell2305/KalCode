import type { ReactNode } from "react";
import claudeSpark from "../brand/providers/claude-spark.svg";
import geminiCliIcon from "../brand/providers/gemini-cli.png";
import openAiBlossom from "../brand/providers/openai-blossom.svg";
import { cx } from "./cx.ts";
import styles from "./ProviderMark.module.css";

/**
 * Provider identity: the provider-published mark plus its name in plain text. Provider identity
 * stays separate from runtime state: status is communicated by adjacent text and status UI.
 */
export type ProviderGlyphKind = "claude" | "codex" | "gemini" | "shell" | "generic";

const KNOWN: Record<string, { glyph: ProviderGlyphKind; name: string }> = {
  "claude-code": { glyph: "claude", name: "Claude Code" },
  codex: { glyph: "codex", name: "Codex" },
  "gemini-cli": { glyph: "gemini", name: "Gemini CLI" },
  shell: { glyph: "shell", name: "Terminal" },
  terminal: { glyph: "shell", name: "Terminal" },
};

/** The glyph kind and default name for a provider id (unknown ids get a lettered hexagon). */
export function providerIdentity(provider: string): { glyph: ProviderGlyphKind; name: string } {
  return KNOWN[provider] ?? { glyph: "generic", name: provider };
}

export interface ProviderGlyphProps {
  provider: string;
  size?: ProviderMarkSize;
  /** Kept for API compatibility. Native provider marks retain their approved treatment. */
  tone?: "accent" | "neutral";
  className?: string;
}

export type ProviderMarkSize = "xs" | "sm" | "md" | "lg";

/** The glyph alone (decorative; always pair it with the name somewhere nearby). */
export function ProviderGlyph({ provider, size = "sm", tone = "accent", className }: ProviderGlyphProps) {
  const { glyph, name } = providerIdentity(provider);
  const nativeSource =
    glyph === "claude" ? claudeSpark : glyph === "codex" ? openAiBlossom : glyph === "gemini" ? geminiCliIcon : null;
  if (nativeSource) {
    return (
      <img
        className={cx(styles.glyph, styles.nativeImage, styles[size], className)}
        data-glyph={glyph}
        data-tone={tone}
        data-brand-source={glyph === "claude" ? "anthropic" : glyph === "codex" ? "openai" : "google-gemini-cli"}
        src={nativeSource}
        alt=""
        aria-hidden="true"
      />
    );
  }

  return (
    <svg
      className={cx(styles.glyph, styles[size], className)}
      data-glyph={glyph}
      data-tone={tone}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[glyph](name)}
    </svg>
  );
}

const GLYPHS: Record<ProviderGlyphKind, (name: string) => ReactNode> = {
  claude: () => null,
  codex: () => null,
  gemini: () => null,
  shell: () => (
    <>
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2" />
      <path d="m4.8 6.2 2 1.8-2 1.8M8.6 10h2.6" />
    </>
  ),
  generic: (name) => (
    <>
      <path d="M8 1.5 13.6 4.75v6.5L8 14.5 2.4 11.25v-6.5Z" />
      <text
        x="8"
        y="10.6"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="7"
        fontWeight="600"
        fontFamily="inherit"
      >
        {name.trim().charAt(0).toUpperCase() || "?"}
      </text>
    </>
  ),
};

export interface ProviderMarkProps extends ProviderGlyphProps {
  /** Display name; defaults to the known name for the id. */
  name?: string;
  /** Hide the visible name (it stays available to assistive tech). Prefer showing it. */
  hideName?: boolean;
  /** Secondary text after the name, e.g. the model ("Sonnet"). */
  detail?: ReactNode;
  /** Put the glyph on a small bordered tile (cards, pane headers). */
  tile?: boolean;
}

/** Glyph + provider name. The standard way to show which provider a thread or pane uses. */
export function ProviderMark({
  provider,
  name,
  hideName = false,
  detail,
  tile = false,
  size = "sm",
  tone = "accent",
  className,
}: ProviderMarkProps) {
  const label = name ?? providerIdentity(provider).name;
  return (
    <span className={cx(styles.mark, styles[`mark-${size}`], className)}>
      <span className={cx(tile && styles.tile)} data-glyph={providerIdentity(provider).glyph}>
        <ProviderGlyph provider={provider} size={size} tone={tone} />
      </span>
      <span className={cx(styles.name, hideName && "visually-hidden")}>{label}</span>
      {detail ? <span className={styles.detail}>{detail}</span> : null}
    </span>
  );
}
