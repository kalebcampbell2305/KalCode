import { ChevronRight } from "lucide-react";
import { ContextMenu as Menu } from "radix-ui";
import { type ReactElement, type ReactNode, useRef } from "react";
import { cx } from "./cx.ts";
import styles from "./DropdownMenu.module.css";
import contextStyles from "./ObjectContextMenu.module.css";

type ActionLabel = { id: string; label: string; icon?: ReactNode; tone?: "danger" };
export type ObjectMenuItem =
  | { id: string; separator: true }
  | (ActionLabel & { onSelect: () => void; children?: never })
  | (ActionLabel & { children: readonly ObjectMenuItem[]; onSelect?: never });

/** Also used by an object's ellipsis button; the event bubbles to its context trigger. */
export function openObjectContextMenu(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(16, rect.width / 2),
      clientY: rect.bottom,
    }),
  );
}

function MenuItems({ items }: { items: readonly ObjectMenuItem[] }) {
  return items.map((item) => {
    if ("separator" in item) return <Menu.Separator key={item.id} className={styles.separator} />;
    const body = (
      <>
        {item.icon ? (
          <span className={styles.icon} aria-hidden="true">
            {item.icon}
          </span>
        ) : null}
        <span className={styles.text}>
          <span className={styles.label}>{item.label}</span>
        </span>
      </>
    );
    const className = cx(styles.item, item.tone === "danger" && styles.danger);
    if (item.children) {
      if (!item.children.length) return null;
      return (
        <Menu.Sub key={item.id}>
          <Menu.SubTrigger className={className}>
            {body}
            <ChevronRight className={contextStyles.chevron} aria-hidden="true" />
          </Menu.SubTrigger>
          <Menu.Portal>
            <Menu.SubContent className={cx(styles.content, contextStyles.content)} collisionPadding={8}>
              <MenuItems items={item.children} />
            </Menu.SubContent>
          </Menu.Portal>
        </Menu.Sub>
      );
    }
    return (
      <Menu.Item key={item.id} className={className} onSelect={item.onSelect}>
        {body}
      </Menu.Item>
    );
  });
}

/** An object-specific menu: no IPC or asynchronous work is needed to open it. */
export function ObjectContextMenu({
  children,
  items,
  label,
  onOpenChange,
}: {
  children: ReactElement;
  items: readonly ObjectMenuItem[];
  label: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const invoker = useRef<HTMLElement | null>(null);
  return (
    <Menu.Root modal={false} onOpenChange={onOpenChange}>
      <Menu.Trigger
        asChild
        disabled={!items.length}
        data-object-context=""
        onContextMenu={(event) => {
          if (!items.length) return;
          event.stopPropagation();
          invoker.current =
            document.activeElement instanceof HTMLElement && event.currentTarget.contains(document.activeElement)
              ? document.activeElement
              : event.currentTarget;
        }}
        onKeyDown={(event) => {
          if (!items.length) return;
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          event.stopPropagation();
          openObjectContextMenu(event.currentTarget);
        }}
      >
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          aria-label={label}
          className={cx(styles.content, contextStyles.content)}
          collisionPadding={8}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Let dialogs/actions that intentionally move focus keep it.
            if (
              !document.activeElement ||
              document.activeElement === document.body ||
              document.activeElement.closest('[role="menu"]')
            ) {
              invoker.current?.focus({ preventScroll: true });
            }
          }}
        >
          <Menu.Label className={cx(styles.menuLabel, contextStyles.label)}>{label}</Menu.Label>
          <MenuItems items={items} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
