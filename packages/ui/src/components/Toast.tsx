import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "./Button.tsx";
import { cx } from "./cx.ts";
import styles from "./Toast.module.css";

export type ToastTone = "success" | "danger" | "info";

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
  /** Milliseconds before auto-dismiss. Errors stay until dismissed. */
  duration?: number;
}

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description: string | undefined;
}

interface ToastApi {
  show: (toast: ToastInput) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS = { success: CircleCheck, danger: CircleAlert, info: Info } as const;
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    ({ tone = "info", title, description, duration }: ToastInput) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-(MAX_VISIBLE - 1)), { id, tone, title, description }]);
      const ms = duration ?? (tone === "danger" ? 0 : 4500);
      if (ms > 0) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className={styles.region} aria-label="Notifications">
        <ol className={styles.list} role="status" aria-live="polite">
          {toasts.map((toast) => {
            const Icon = ICONS[toast.tone];
            return (
              <li key={toast.id} className={cx(styles.toast, styles[toast.tone])}>
                <span className={styles.icon} aria-hidden="true">
                  <Icon />
                </span>
                <div>
                  <p className={styles.title}>{toast.title}</p>
                  {toast.description ? <p className={styles.description}>{toast.description}</p> : null}
                </div>
                <IconButton size="sm" label="Dismiss notification" icon={<X />} onClick={() => dismiss(toast.id)} />
              </li>
            );
          })}
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
