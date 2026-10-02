import { Tooltip as RadixTooltip } from "radix-ui";
import { cloneElement, type ReactElement, type ReactNode, useId, useState } from "react";
import styles from "./Tooltip.module.css";

export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** A single focusable element that forwards refs. */
  children: ReactElement;
  /** Keeps the tooltip closed, e.g. while the menu its trigger opened is showing. */
  hidden?: boolean;
}

/** Supplementary hint on hover and focus. Never the only place essential information lives. */
export function Tooltip({ content, side = "top", children, hidden = false }: TooltipProps) {
  const [requested, setOpen] = useState(false);
  const open = requested && !hidden;
  const contentId = useId();
  const trigger = children as ReactElement<{ "aria-describedby"?: string }>;
  // asChild gives child props precedence, so include both descriptions on the child itself.
  const describedBy = [trigger.props["aria-describedby"], open && contentId].filter(Boolean).join(" ") || undefined;

  return (
    <RadixTooltip.Root delayDuration={350} open={open} onOpenChange={setOpen}>
      <RadixTooltip.Trigger asChild>{cloneElement(trigger, { "aria-describedby": describedBy })}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content id={contentId} side={side} sideOffset={6} className={styles.content}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
