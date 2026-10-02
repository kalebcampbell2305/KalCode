import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "./Button.tsx";
import { cx } from "./cx.ts";
import styles from "./Toast.module.css";

export type ToastTone = "success" | "danger" | "info";

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
  /** Milliseconds before auto-dismiss. Errors stay until dismissed. */
  duration?: number;
  /** One follow-up action ("Review"); choosing it also dismisses the toast. */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  onSelect: () => void;
}

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description: string | undefined;
  duration: number;
  action: ToastAction | undefined;
}

interface ToastApi {
  show: (toast: ToastInput) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS = { success: CircleCheck, danger: CircleAlert, info: Info } as const;
const MAX_VISIBLE = 4;

function Toast({
  toast,
  dismiss,
  setFocused,
}: {
  toast: ToastItem;
  dismiss: (id: number) => void;
  setFocused: (id: number, focused: boolean) => void;
}) {
  const remaining = useRef(toast.duration);
  const started = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pause = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    remaining.current = Math.max(0, remaining.current - (performance.now() - started.current));
  }, []);
  const resume = useCallback(() => {
    if (!(toast.duration > 0) || timer.current !== null) return;
    started.current = performance.now();
    timer.current = setTimeout(() => dismiss(toast.id), remaining.current);
  }, [dismiss, toast.duration, toast.id]);

  // Each toast owns its timer, so dismissal, eviction and unmount all clean it up.
  useEffect(() => {
    resume();
    return pause;
  }, [pause, resume]);

  useEffect(() => () => setFocused(toast.id, false), [setFocused, toast.id]);

  const Icon = ICONS[toast.tone];
  return (
    <li
      className={cx(styles.toast, styles[toast.tone])}
      onFocus={() => {
        setFocused(toast.id, true);
        pause();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(toast.id, false);
          resume();
        }
      }}
    >
      <span className={styles.icon} aria-hidden="true">
        <Icon />
      </span>
      <div>
        <p className={styles.title}>{toast.title}</p>
        {toast.description ? <p className={styles.description}>{toast.description}</p> : null}
        {toast.action ? (
          <Button
            size="sm"
            variant="ghost"
            className={styles.action}
            onClick={() => {
              dismiss(toast.id);
              toast.action?.onSelect();
            }}
          >
            {toast.action.label}
          </Button>
        ) : null}
      </div>
      <IconButton size="sm" label="Dismiss notification" icon={<X />} onClick={() => dismiss(toast.id)} />
    </li>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const focusedId = useRef<number | null>(null);

  const setFocused = useCallback((id: number, focused: boolean) => {
    if (focused) focusedId.current = id;
    else if (focusedId.current === id) focusedId.current = null;
  }, []);

  const dismiss = useCallback((id: number) => {
    if (focusedId.current === id) focusedId.current = null;
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(({ tone = "info", title, description, duration, action }: ToastInput) => {
    const id = nextId.current++;
    const protectedId = focusedId.current;
    setToasts((current) => {
      const evictIndex = current.length >= MAX_VISIBLE ? current.findIndex((toast) => toast.id !== protectedId) : -1;
      return [
        ...current.filter((_, index) => index !== evictIndex),
        { id, tone, title, description, duration: duration ?? (tone === "danger" ? 0 : 4500), action },
      ];
    });
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className={styles.region} aria-label="Notifications">
        <ol className={styles.list} role="status" aria-live="polite">
          {toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} dismiss={dismiss} setFocused={setFocused} />
          ))}
        </ol>
      </section>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
