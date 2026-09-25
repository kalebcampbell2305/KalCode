import { Tabs as Radix } from "radix-ui";
import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { cx } from "./cx.ts";
import styles from "./Tabs.module.css";

/**
 * Tabs (WAI-ARIA tabs from Radix: arrow keys move between tabs, Home/End, automatic activation).
 * `variant="line"` is the app's tab strip (a lit underline on the active tab); `"pill"` sits
 * inside panel headers.
 */
export const Tabs = Radix.Root;

export interface TabsListProps extends ComponentPropsWithoutRef<typeof Radix.List> {
  variant?: "line" | "pill";
}

export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(function TabsList(
  { variant = "line", className, ...rest },
  ref,
) {
  return <Radix.List ref={ref} className={cx(styles.list, styles[variant], className)} {...rest} />;
});

export const TabsTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Radix.Trigger>>(
  function TabsTrigger({ className, ...rest }, ref) {
    return <Radix.Trigger ref={ref} className={cx(styles.trigger, className)} {...rest} />;
  },
);

export const TabsContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Radix.Content>>(
  function TabsContent({ className, ...rest }, ref) {
    return <Radix.Content ref={ref} className={cx(styles.content, className)} {...rest} />;
  },
);
