import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  Maximize2,
  RefreshCw,
  Square,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import type { PaneRenderContext } from "../../shell/panes/contentRegistry.ts";
import styles from "./BrowserPane.module.css";
import {
  type BrowserBounds,
  type BrowserBridge,
  type BrowserState,
  nextBrowserVisibilityVersion,
} from "./browserBridge.ts";
import {
  type BrowserPaneContent,
  clampCustomViewport,
  normalizeBrowserAddress,
  type ViewportPreset,
  viewportWidth,
} from "./browserModel.ts";
import { subscribeBrowserLayout, useBrowserVisibility } from "./browserVisibility.ts";

const DEFAULT_URL = "http://localhost:3000/";
const ATTACH_RETRY_DELAYS_MS = [20, 40, 80, 160, 320, 640, 760] as const;
const RETRYABLE_ATTACH_CODES = new Set(["browser_closing", "browser_starting", "browser_closed_during_start"]);

async function attachWithRetry(
  bridge: BrowserBridge,
  request: Parameters<BrowserBridge["attach"]>[0],
  shouldContinue: () => boolean,
): Promise<BrowserState> {
  for (let attempt = 0; ; attempt += 1) {
    if (!shouldContinue()) throw new Error("Browser attach was cancelled.");
    try {
      return await bridge.attach(request);
    } catch (cause) {
      const error = toKalCodeError(cause, "browser_attach");
      const delay = ATTACH_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !shouldContinue() || !RETRYABLE_ATTACH_CODES.has(error.code)) throw error;
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
  }
}

export interface BrowserPaneProps {
  content: BrowserPaneContent;
  workspaceId: string;
  context: PaneRenderContext;
  bridge: BrowserBridge;
  /** Ephemeral full URL for a newly opened pane. It is never required in persisted layout state. */
  initialUrl?: string | null;
  /** Route-level visibility. The component also hides for dialogs, document hiding and zero bounds. */
  visible: boolean;
  onRequestFocus: () => void;
  /** Receives a safe runtime URL; model persistence removes its query and fragment. */
  onUrlChange: (url: string) => void;
}

function rectBounds(element: HTMLElement): BrowserBounds {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}

export function BrowserPane({
  content,
  workspaceId,
  context,
  bridge,
  initialUrl,
  visible: routeVisible,
  onRequestFocus,
  onUrlChange,
}: BrowserPaneProps) {
  const [viewport, setViewport] = useState<HTMLButtonElement | null>(null);
  const [state, setState] = useState<BrowserState | null>(null);
  const attachUrl = useRef(initialUrl ?? content.url ?? DEFAULT_URL);
  const [address, setAddress] = useState(attachUrl.current);
  const [error, setError] = useState<string | null>(null);
  // Attach failed: the pane never opened. Retry bumps `attachAttempt`, which re-runs the attach.
  const [attachFailure, setAttachFailure] = useState<string | null>(null);
  const [attachAttempt, setAttachAttempt] = useState(0);
  const [preset, setPreset] = useState<ViewportPreset>("fluid");
  const [customWidth, setCustomWidth] = useState(900);
  // The width field's text while it is edited; bounding every keystroke would turn "1" into 320.
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  // "Copy URL" confirms itself briefly, so the click is visibly acknowledged.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const attached = useRef(false);
  const addressEditing = useRef(false);
  const alive = useRef(true);
  const queued = useRef<Promise<unknown>>(Promise.resolve());
  const browserVisible = useBrowserVisibility(viewport, routeVisible);
  const lastVisibility = useRef(browserVisible);
  const [initialVisibilityVersion] = useState(nextBrowserVisibilityVersion);
  const visibilityVersion = useRef(initialVisibilityVersion);
  const desiredVisible = useRef(browserVisible);
  if (lastVisibility.current !== browserVisible) {
    lastVisibility.current = browserVisible;
    visibilityVersion.current = nextBrowserVisibilityVersion();
  }
  desiredVisible.current = browserVisible;

  const run = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = queued.current.then(work, work);
    queued.current = next.catch(() => undefined);
    return next;
  }, []);

  const acceptState = useCallback(
    (next: BrowserState) => {
      if (!alive.current) return;
      setState(next);
      if (!addressEditing.current) setAddress(next.url);
      onUrlChange(next.url);
    },
    [onUrlChange],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!viewport) return;
    const resize = () =>
      setAvailableWidth(
        viewport.parentElement?.getBoundingClientRect().width ?? viewport.getBoundingClientRect().width,
      );
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    if (viewport.parentElement) observer.observe(viewport.parentElement);
    resize();
    return () => observer.disconnect();
  }, [viewport]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attachAttempt` is the Retry trigger; it re-runs the attach after a failure.
  useEffect(() => {
    if (!viewport) return;
    let cancelled = false;
    const bounds = rectBounds(viewport);
    void run(async () => {
      try {
        const next = attached.current
          ? await bridge.setView({
              browserId: content.browserId,
              bounds,
              visible: browserVisible,
              visibilityVersion: visibilityVersion.current,
            })
          : await attachWithRetry(
              bridge,
              {
                browserId: content.browserId,
                workspaceId,
                url: normalizeBrowserAddress(attachUrl.current),
                bounds,
                visible: browserVisible,
                visibilityVersion: visibilityVersion.current,
              },
              () => !cancelled && alive.current,
            );
        attached.current = true;
        if (cancelled) return;
        setError(null);
        setAttachFailure(null);
        acceptState(next);
      } catch (cause) {
        if (cancelled) return;
        if (attached.current) {
          setError("KalCode couldn't update this browser pane.");
          return;
        }
        setAttachFailure(toKalCodeError(cause, "browser_attach").message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [acceptState, bridge, browserVisible, content.browserId, run, viewport, workspaceId, attachAttempt]);

  // Hiding trusted overlays cannot wait behind ordinary navigation/status work. The version makes
  // every older queued show stale at the native boundary, including an attach still in flight.
  useEffect(() => {
    if (!viewport || browserVisible) return;
    void bridge
      .setView({
        browserId: content.browserId,
        bounds: rectBounds(viewport),
        visible: false,
        visibilityVersion: visibilityVersion.current,
      })
      .catch(() => void bridge.hideAll().catch(() => void bridge.close(content.browserId).catch(() => undefined)));
  }, [bridge, browserVisible, content.browserId, viewport]);

  useEffect(() => {
    if (!viewport) return;
    let last = "";
    const sync = () => {
      const bounds = rectBounds(viewport);
      const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      if (key === last) return;
      last = key;
      void run(() =>
        bridge
          .setView({
            browserId: content.browserId,
            bounds,
            visible: desiredVisible.current,
            visibilityVersion: visibilityVersion.current,
          })
          .then(acceptState),
      ).catch(() => {
        setError("KalCode couldn't resize this browser pane.");
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    const unsubscribeLayout = subscribeBrowserLayout(sync);
    sync();
    return () => {
      observer.disconnect();
      unsubscribeLayout();
    };
  }, [acceptState, bridge, content.browserId, run, viewport]);

  useEffect(() => {
    if (!viewport) return;
    return () => {
      const bounds = rectBounds(viewport);
      desiredVisible.current = false;
      visibilityVersion.current = nextBrowserVisibilityVersion();
      void bridge
        .setView({
          browserId: content.browserId,
          bounds,
          visible: false,
          visibilityVersion: visibilityVersion.current,
        })
        .catch(() => void bridge.close(content.browserId).catch(() => undefined));
    };
  }, [bridge, content.browserId, viewport]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void bridge
      .subscribeFocus((event) => {
        if (event.browserId === content.browserId && browserVisible) onRequestFocus();
      })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [bridge, browserVisible, content.browserId, onRequestFocus]);

  useEffect(() => {
    if (!browserVisible) return;
    const timer = window.setInterval(() => {
      if (!attached.current) return;
      void bridge
        .info(content.browserId)
        .then(acceptState)
        .catch(() => {
          setError("Browser status is temporarily unavailable.");
        });
    }, 750);
    return () => window.clearInterval(timer);
  }, [acceptState, bridge, browserVisible, content.browserId]);

  useEffect(() => {
    if (!context.focused || !routeVisible || !attached.current) return;
    const addressField = document.getElementById(`browser-address-${content.browserId}`);
    if (context.focusRequest > 0 && addressField instanceof HTMLInputElement) addressField.focus();
  }, [content.browserId, context.focusRequest, context.focused, routeVisible]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onRequestFocus();
    let url: string;
    try {
      url = normalizeBrowserAddress(address);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid web address.");
      return;
    }
    setError(null);
    setAddress(url);
    void run(() => bridge.navigate(content.browserId, url))
      .then(acceptState)
      .catch(() => {
        setError("KalCode couldn't navigate to that address.");
      });
  };

  const action = (name: "back" | "forward" | "reload" | "stop") => {
    onRequestFocus();
    void run(() => bridge.action(content.browserId, name))
      .then(acceptState)
      .catch(() => {
        setError("That browser action didn't complete.");
      });
  };

  const copyUrl = () => {
    void navigator.clipboard.writeText(state?.url ?? address).then(
      () => {
        if (!alive.current) return;
        setCopied(true);
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => {
          copiedTimer.current = null;
          setCopied(false);
        }, 1500);
      },
      () => {
        if (alive.current) setError("KalCode couldn't copy the address.");
      },
    );
  };

  const openExternally = () => {
    let url: string;
    try {
      url = normalizeBrowserAddress(state?.url ?? address);
    } catch {
      setError("Enter a valid web address.");
      return;
    }
    void bridge.openExternal(url).catch(() => setError("KalCode couldn't open the system browser."));
  };

  // The footer never says Ready for a pane that isn't open.
  const footerLabel = attachFailure
    ? "Couldn't open"
    : state?.loading
      ? "Loading"
      : state
        ? state.title || "Ready"
        : "Opening…";

  const desiredWidth = viewportWidth(preset, customWidth, availableWidth || 1);
  const button = (label: string, icon: React.ReactNode, onClick: () => void, disabled = false) => (
    <button
      type="button"
      className={styles.iconButton}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
    </button>
  );

  return (
    <div className={styles.root} data-browser-id={content.browserId} onPointerDown={onRequestFocus}>
      <div className={styles.toolbar} role="toolbar" aria-label="Browser controls">
        <div className={styles.navigation}>
          {button("Back", <ArrowLeft size={15} />, () => action("back"), !state)}
          {button("Forward", <ArrowRight size={15} />, () => action("forward"), !state)}
          {state?.loading
            ? button("Stop loading", <Square size={13} />, () => action("stop"))
            : button("Reload", <RefreshCw size={14} />, () => action("reload"), !state)}
        </div>
        <form className={styles.addressForm} onSubmit={submit}>
          <label className={styles.srOnly} htmlFor={`browser-address-${content.browserId}`}>
            Web address
          </label>
          <input
            id={`browser-address-${content.browserId}`}
            className={styles.address}
            value={address}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setAddress(event.currentTarget.value)}
            onFocus={() => {
              addressEditing.current = true;
              onRequestFocus();
            }}
            onBlur={() => {
              addressEditing.current = false;
              if (state?.url) setAddress(state.url);
            }}
          />
        </form>
        <select
          className={styles.preset}
          aria-label="Responsive viewport"
          value={preset}
          onChange={(event) => setPreset(event.currentTarget.value as ViewportPreset)}
        >
          <option value="fluid">Fit pane</option>
          <option value="desktop">Desktop</option>
          <option value="laptop">Laptop</option>
          <option value="tablet">Tablet</option>
          <option value="mobile">Mobile</option>
          <option value="custom">Custom</option>
        </select>
        {preset === "custom" ? (
          <input
            className={styles.customWidth}
            type="number"
            min={320}
            max={3840}
            aria-label="Custom viewport width"
            value={customDraft ?? customWidth}
            onChange={(event) => {
              const typed = event.currentTarget.valueAsNumber;
              setCustomDraft(event.currentTarget.value);
              // Preview a width as soon as it is in range; out-of-range text is bounded on commit.
              if (clampCustomViewport(typed) === typed) setCustomWidth(typed);
            }}
            onBlur={() => {
              if (customDraft === null) return;
              // An emptied field keeps the last width.
              const typed = Number.parseFloat(customDraft);
              if (Number.isFinite(typed)) setCustomWidth(clampCustomViewport(typed));
              setCustomDraft(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        ) : null}
        {copied ? button("URL copied", <Check size={14} />, copyUrl) : button("Copy URL", <Copy size={14} />, copyUrl)}
        {button("Open externally", <ExternalLink size={14} />, openExternally)}
      </div>
      <div className={styles.stage}>
        <button
          type="button"
          ref={setViewport}
          className={styles.viewport}
          style={{ width: desiredWidth, padding: 0, borderBlock: 0, color: "inherit", font: "inherit" }}
          aria-label={state?.title ? `Browser: ${state.title}` : "Browser preview"}
          onFocus={() => {
            onRequestFocus();
            if (attached.current) void bridge.focus(content.browserId).catch(() => undefined);
          }}
        >
          {attachFailure ? null : !browserVisible || error ? (
            <span className={styles.fallback}>
              {error ? <span>{error}</span> : <span>Browser preview paused</span>}
            </span>
          ) : null}
        </button>
        {attachFailure ? (
          <div className={styles.failure} role="alert">
            <p className={styles.failureTitle}>KalCode couldn't open this browser pane.</p>
            <p className={styles.failureReason}>{attachFailure}</p>
            <div className={styles.failureActions}>
              <button
                type="button"
                className={styles.failureButton}
                onClick={() => {
                  setAttachFailure(null);
                  setError(null);
                  setAttachAttempt((n) => n + 1);
                }}
              >
                Retry
              </button>
              <button type="button" className={styles.failureButton} onClick={openExternally}>
                Open in system browser
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <footer className={styles.status} aria-live="polite">
        <span className={styles.statusTitle}>
          {state?.loading ? (
            <LoaderCircle className={styles.spinner} size={12} aria-hidden="true" />
          ) : (
            <Maximize2 size={12} aria-hidden="true" />
          )}
          {footerLabel}
        </span>
        <span className={styles.statusUrl}>{state?.url ?? address}</span>
      </footer>
    </div>
  );
}
