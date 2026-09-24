import { Tooltip as RadixTooltip } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import styles from "./Tooltip.module.css";

export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** A single focusable element that forwards refs. */
  children: ReactElement;
}

/** Supplementary hint on hover and focus. Never the only place essential information lives. */
export function Tooltip({ content, side = "top", children }: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={350}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} sideOffset={6} className={styles.content}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
