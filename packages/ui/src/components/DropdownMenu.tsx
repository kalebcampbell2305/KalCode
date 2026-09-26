import { Check } from "lucide-react";
import { DropdownMenu as Radix, Slot } from "radix-ui";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { cx } from "./cx.ts";
import styles from "./DropdownMenu.module.css";

/**
 * A menu of actions or choices opened from a trigger. Keyboard behaviour (arrow keys, typeahead,
 * Escape, focus return) comes from Radix; styling is tokens only.
 */
export function DropdownMenu({ modal = false, ...props }: ComponentPropsWithoutRef<typeof Radix.Root>) {
  // Non-modal by default: the rest of the app stays in the accessibility tree (a modal menu
  // hides it with aria-hidden while focusable controls remain), and clicking outside closes it.
  return <Radix.Root modal={modal} {...props} />;
}
export const DropdownMenuTrigger = Radix.Trigger;
export const DropdownMenuGroup = Radix.Group;
export const DropdownMenuRadioGroup = Radix.RadioGroup;

export interface DropdownMenuContentProps extends ComponentPropsWithoutRef<typeof Radix.Content> {
  /** Minimum width in rem; defaults to the trigger's width. */
  minWidth?: number;
}

export const DropdownMenuContent = forwardRef<HTMLDivElement, DropdownMenuContentProps>(function DropdownMenuContent(
  { className, sideOffset = 6, align = "start", minWidth, style, ...rest },
  ref,
) {
  return (
    <Radix.Portal>
      <Radix.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cx(styles.content, className)}
        style={minWidth ? { minWidth: `${minWidth}rem`, ...style } : style}
        {...rest}
      />
    </Radix.Portal>
  );
});

interface ItemContent {
  icon?: ReactNode;
  /** Secondary line under the label (e.g. a folder path). */
  description?: ReactNode;
  /** Keyboard shortcut hint shown at the end. */
  shortcut?: string;
  children: ReactNode;
}

function Body({ icon, description, shortcut, children }: ItemContent) {
  return (
    <>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.text}>
        <span className={styles.label}>{children}</span>
        {description ? <span className={styles.description}>{description}</span> : null}
      </span>
      {shortcut ? <kbd className={styles.shortcut}>{shortcut}</kbd> : null}
    </>
  );
}

export interface DropdownMenuItemProps
  extends Omit<ComponentPropsWithoutRef<typeof Radix.Item>, "children">,
    ItemContent {
  tone?: "default" | "danger";
}

export const DropdownMenuItem = forwardRef<HTMLDivElement, DropdownMenuItemProps>(function DropdownMenuItem(
  { className, icon, description, shortcut, children, tone = "default", ...rest },
  ref,
) {
  return (
    <Radix.Item ref={ref} className={cx(styles.item, tone === "danger" && styles.danger, className)} {...rest}>
      <Slot.Slottable child={children}>
        {(label) => (
          <Body icon={icon} description={description} shortcut={shortcut}>
            {label}
          </Body>
        )}
      </Slot.Slottable>
    </Radix.Item>
  );
});

export interface DropdownMenuRadioItemProps
  extends Omit<ComponentPropsWithoutRef<typeof Radix.RadioItem>, "children">,
    Omit<ItemContent, "icon"> {}

/** A choice in a `DropdownMenuRadioGroup`; the selected one shows a check. */
export const DropdownMenuRadioItem = forwardRef<HTMLDivElement, DropdownMenuRadioItemProps>(
  function DropdownMenuRadioItem({ className, description, shortcut, children, ...rest }, ref) {
    return (
      <Radix.RadioItem ref={ref} className={cx(styles.item, styles.choice, className)} {...rest}>
        <span className={styles.indicator} aria-hidden="true">
          <Radix.ItemIndicator>
            <Check />
          </Radix.ItemIndicator>
        </span>
        <Slot.Slottable child={children}>
          {(label) => (
            <Body description={description} shortcut={shortcut}>
              {label}
            </Body>
          )}
        </Slot.Slottable>
      </Radix.RadioItem>
    );
  },
);

export function DropdownMenuLabel({ className, ...rest }: ComponentPropsWithoutRef<typeof Radix.Label>) {
  return <Radix.Label className={cx(styles.menuLabel, className)} {...rest} />;
}

export function DropdownMenuSeparator({ className, ...rest }: ComponentPropsWithoutRef<typeof Radix.Separator>) {
  return <Radix.Separator className={cx(styles.separator, className)} {...rest} />;
}
