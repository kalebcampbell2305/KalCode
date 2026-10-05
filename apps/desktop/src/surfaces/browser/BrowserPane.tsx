import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Copy,
  Crosshair,
  ExternalLink,
  FolderOpen,
  Globe,
  LoaderCircle,
  Lock,
  LogIn,
  Monitor,
  RotateCw,
  Server,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { FavoriteButton, FavoriteToggle } from "../../shell/favorites/FavoriteActions.tsx";
import type { PaneRenderContext } from "../../shell/panes/contentRegistry.ts";
import { BrowserAsk } from "./BrowserAsk.tsx";
import styles from "./BrowserPane.module.css";
import {
  type BrowserBounds,
  type BrowserBridge,
  type BrowserScreenshot,
  type BrowserState,
  nextBrowserVisibilityVersion,
  type PickedElement,
} from "./browserBridge.ts";
import {
  type BrowserPaneContent,
  clampCustomViewport,
  normalizeBrowserAddress,
  type ViewportPreset,
  viewportWidth,
} from "./browserModel.ts";
import { subscribeBrowserLayout, useBrowserVisibility } from "./browserVisibility.ts";
import {
  type AuthNotice,
  agentLabel,
  authNotice,
  buildAgentPrompt,
  isLocalUrl,
  LIVE_BROWSER_TARGETS,
  type LiveBrowserAgent,
  type LiveBrowserTarget,
  rememberedTargets,
  rememberTarget,
  resolveTargets,
  TARGET_LABEL,
  targetForUrl,
} from "./liveBrowser.ts";
import { type LiveBrowserServices, useLiveBrowserServices } from "./useLiveBrowserServices.ts";

const DEFAULT_URL = "http://localhost:3000/";
const ATTACH_RETRY_DELAYS_MS = [20, 40, 80, 160, 320, 640, 760] as const;
const RETRYABLE_ATTACH_CODES = new Set(["browser_closing", "browser_starting", "browser_closed_during_start"]);
/** Native status backstop: native announces navigation, loads, titles and pop-ups as events, so
 *  an unchanged pane is re-read less and less often (in-page history moves have no event). */
const INFO_MS = 750;
const INFO_MAX_MS = 6_000;
/** Page errors and picks are read from the page helper; quieter while nothing changes. */
const INSPECT_MS = 2_000;
const INSPECT_MAX_MS = 6_000;
const PICKING_INSPECT_MS = 350;
const NOTICE_MS = 6_000;

const PRESET_LABEL: Record<ViewportPreset, string> = {
  fluid: "Fit pane",
  desktop: "Desktop · 1440",
  laptop: "Laptop · 1280",
  tablet: "Tablet · 768",
  mobile: "Mobile · 390",
  custom: "Custom width",
};

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
  /** The coding agent this Browser was opened beside: Ask Agent preselects it. */
  preferredAgentId?: string | null;
  /** Overrides what the pane reads from the app (tests, previews). Defaults to the live app. */
  services?: LiveBrowserServices;
}

type Notice =
  | { kind: "picking" }
  | { kind: "auth"; auth: AuthNotice; key: string }
  | { kind: "screenshot"; shot: BrowserScreenshot }
  | { kind: "sent"; agent: string }
  | { kind: "error"; text: string };

function rectBounds(element: HTMLElement): BrowserBounds {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

function AddressGlyph({ url }: { url: string }) {
  if (isLocalUrl(url)) return <Server size={13} aria-hidden="true" />;
  if (url.startsWith("https://")) return <Lock size={12} aria-hidden="true" />;
  return <Globe size={13} aria-hidden="true" />;
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
  preferredAgentId = null,
  services: servicesOverride,
}: BrowserPaneProps) {
  const appServices = useLiveBrowserServices(workspaceId);
  const services = servicesOverride ?? appServices;
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
  // Live Browser: targets, page errors, picking, screenshots and Ask Agent.
  const [remembered, setRemembered] = useState(() => rememberedTargets(workspaceId));
  const [pendingTarget, setPendingTarget] = useState<LiveBrowserTarget | null>(null);
  const [errors, setErrors] = useState<{ count: number; list: string[] }>({ count: 0, list: [] });
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [screenshot, setScreenshot] = useState<BrowserScreenshot | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [panel, setPanel] = useState<"ask" | "errors" | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dismissedAuth, setDismissedAuth] = useState<string | null>(null);
  const lastSiteUrl = useRef<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );
  const attached = useRef(false);
  const addressEditing = useRef(false);
  const addressInput = useRef<HTMLInputElement | null>(null);
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

  const targets = useMemo(
    () => resolveTargets(workspaceId, services.snapshot, remembered),
    [workspaceId, services.snapshot, remembered],
  );
  const currentUrl = state?.url ?? address;
  const activeTarget = pendingTarget ?? targetForUrl(currentUrl, targets);

  const showNotice = useCallback((next: Notice | null, transient = false) => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNotice(next);
    if (next && transient) {
      noticeTimer.current = window.setTimeout(() => {
        noticeTimer.current = null;
        setNotice((current) => (current === next ? null : current));
      }, NOTICE_MS);
    }
  }, []);

  const run = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = queued.current.then(work, work);
    queued.current = next.catch(() => undefined);
    return next;
  }, []);

  const rememberedFor = useRef<string | null>(null);
  // The last state shown, so a status read that changed nothing renders nothing.
  const shownState = useRef("");
  const acceptState = useCallback(
    (next: BrowserState) => {
      if (!alive.current) return;
      shownState.current = JSON.stringify(next);
      setState(next);
      if (!addressEditing.current) setAddress(next.url);
      onUrlChange(next.url);
      if (!next.url.includes("accounts.google.com")) lastSiteUrl.current = next.url;
      // Remember the local dev address the person actually uses, once per change.
      if (rememberedFor.current !== next.url && isLocalUrl(next.url)) {
        rememberedFor.current = next.url;
        rememberTarget(workspaceId, "local", next.url);
      }
    },
    [onUrlChange, workspaceId],
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
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void bridge
      .subscribeFocus((event) => {
        if (event.browserId === content.browserId && browserVisible) onRequestFocus();
      })
      .then((dispose) => {
        // Unmounted while subscribing: release the listener now instead of leaking it.
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [bridge, browserVisible, content.browserId, onRequestFocus]);

  // Status: read at once when native says this pane moved; otherwise poll, backing off while
  // nothing changes and staying quick while a page loads.
  useEffect(() => {
    if (!browserVisible) return;
    let disposed = false;
    let timer: number | undefined;
    let delay = INFO_MS;
    let reading = false;
    // Native announced a move while a read was in flight: that read may predate it.
    let movedWhileReading = false;
    const schedule = (wait: number) => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = disposed ? undefined : window.setTimeout(read, wait);
    };
    const read = () => {
      timer = undefined;
      if (disposed) return;
      if (!attached.current || reading) {
        schedule(INFO_MS);
        return;
      }
      reading = true;
      bridge
        .info(content.browserId)
        .then((next) => {
          if (disposed) return;
          const changed = JSON.stringify(next) !== shownState.current;
          if (changed) acceptState(next);
          delay = changed || next.loading ? INFO_MS : Math.min(delay * 2, INFO_MAX_MS);
        })
        .catch(() => {
          if (!disposed) setError("Browser status is temporarily unavailable.");
        })
        .finally(() => {
          reading = false;
          schedule(movedWhileReading ? 0 : delay);
          movedWhileReading = false;
        });
    };
    let unlisten: (() => void) | undefined;
    void bridge
      .subscribeState((event) => {
        if (event.browserId !== content.browserId || disposed) return;
        delay = INFO_MS;
        if (reading) movedWhileReading = true;
        else schedule(0);
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    schedule(INFO_MS);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [acceptState, bridge, browserVisible, content.browserId]);

  // Page errors and picks come from the page helper. Faster while the person is picking, slower
  // while nothing changes; a page that moves (address, title or load) is read quickly again.
  const pageState = state ? `${state.url} ${state.title ?? ""} ${state.loading}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pageState` restarts the quick cadence.
  useEffect(() => {
    if (!browserVisible) return;
    let disposed = false;
    let timer: number | undefined;
    let delay = picking ? PICKING_INSPECT_MS : INSPECT_MS;
    let lastSeen: string | null = null;
    const schedule = () => {
      if (!disposed) timer = window.setTimeout(read, delay);
    };
    const read = () => {
      if (!attached.current) {
        schedule();
        return;
      }
      void bridge
        .inspect(content.browserId)
        .then((inspection) => {
          if (disposed || !alive.current || !inspection.available) return;
          const seen = JSON.stringify([inspection.errorCount, inspection.errors, inspection.picking]);
          if (!picking) delay = seen === lastSeen ? Math.min(delay * 2, INSPECT_MAX_MS) : INSPECT_MS;
          lastSeen = seen;
          setErrors((previous) =>
            previous.count === inspection.errorCount && previous.list.join("\n") === inspection.errors.join("\n")
              ? previous
              : { count: inspection.errorCount, list: inspection.errors },
          );
          if (inspection.picked) {
            setPicked(inspection.picked);
            setPicking(false);
            setPanel("ask");
            showNotice(null);
          } else if (picking && !inspection.picking) {
            // Esc in the page cancelled picking.
            setPicking(false);
            showNotice(null);
          }
        })
        .catch(() => undefined)
        .finally(schedule);
    };
    read();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [bridge, browserVisible, content.browserId, picking, showNotice, pageState]);

  // A new page starts with no errors of its own.
  const pageKey = state?.url ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per page address.
  useEffect(() => {
    setErrors({ count: 0, list: [] });
  }, [pageKey]);

  // Sign-in guidance follows the page and denied pop-ups.
  const auth = useMemo(() => authNotice(currentUrl, state?.blockedPopup ?? null), [currentUrl, state?.blockedPopup]);
  const authKey = auth ? `${auth.kind}:${state?.blockedPopupSeq ?? 0}:${hostOf(currentUrl)}` : null;
  useEffect(() => {
    if (!auth || !authKey || authKey === dismissedAuth) {
      setNotice((current) => (current?.kind === "auth" ? null : current));
      return;
    }
    setNotice((current) =>
      current && current.kind !== "auth" && current.kind !== "sent" ? current : { kind: "auth", auth, key: authKey },
    );
  }, [auth, authKey, dismissedAuth]);

  useEffect(() => {
    if (!context.focused || !routeVisible || !attached.current) return;
    const addressField = document.getElementById(`browser-address-${content.browserId}`);
    if (context.focusRequest > 0 && addressField instanceof HTMLInputElement) addressField.focus();
  }, [content.browserId, context.focusRequest, context.focused, routeVisible]);

  const navigateTo = useCallback(
    (url: string) => {
      setError(null);
      setAddress(url);
      void run(() => bridge.navigate(content.browserId, url))
        .then(acceptState)
        .catch(() => {
          setError("KalCode couldn't navigate to that address.");
        });
    },
    [acceptState, bridge, content.browserId, run],
  );

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
    if (pendingTarget) {
      rememberTarget(workspaceId, pendingTarget, url);
      setRemembered(rememberedTargets(workspaceId));
      setPendingTarget(null);
    }
    navigateTo(url);
  };

  const chooseTarget = (target: LiveBrowserTarget) => {
    onRequestFocus();
    const url = targets[target].url;
    if (url) {
      setPendingTarget(null);
      navigateTo(url);
      return;
    }
    // No address known yet: the address bar asks for it once, and KalCode remembers it.
    setPendingTarget(target);
    setAddress("");
    window.requestAnimationFrame(() => addressInput.current?.focus());
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

  const openExternally = (url: string = state?.url ?? address) => {
    let normalized: string;
    try {
      normalized = normalizeBrowserAddress(url);
    } catch {
      setError("Enter a valid web address.");
      return;
    }
    void bridge.openExternal(normalized).catch(() => setError("KalCode couldn't open the system browser."));
  };

  const togglePicking = () => {
    onRequestFocus();
    const next = !picking;
    setPicking(next);
    showNotice(next ? { kind: "picking" } : null);
    void bridge
      .pick(content.browserId, next)
      .then((active) => {
        if (!alive.current) return;
        if (next && !active) {
          setPicking(false);
          showNotice({ kind: "error", text: "This page isn't ready for picking yet." }, true);
        }
        // Put keyboard focus in the page so Esc reaches the picker.
        if (next && active) void bridge.focus(content.browserId).catch(() => undefined);
      })
      .catch((cause) => {
        if (!alive.current) return;
        setPicking(false);
        showNotice({ kind: "error", text: toKalCodeError(cause, "browser_pick").message }, true);
      });
  };

  const takeScreenshot = () => {
    if (capturing) return;
    onRequestFocus();
    setCapturing(true);
    void bridge
      .screenshot(content.browserId)
      .then((shot) => {
        if (!alive.current) return;
        setScreenshot(shot);
        // Inside Ask Agent the screenshot chip is the confirmation.
        if (panelRef.current !== "ask") showNotice({ kind: "screenshot", shot }, true);
      })
      .catch((cause) => {
        if (alive.current)
          showNotice({ kind: "error", text: toKalCodeError(cause, "browser_screenshot").message }, true);
      })
      .finally(() => {
        if (alive.current) setCapturing(false);
      });
  };

  const askAgent = async (agent: LiveBrowserAgent, question: string, options: { includeErrors: boolean }) => {
    const prompt = buildAgentPrompt({
      question,
      url: state?.url ?? address,
      title: state?.title ?? null,
      element: picked,
      errors: options.includeErrors ? errors.list : [],
      screenshotPath: screenshot?.path ?? null,
    });
    await services.ask(agent, prompt);
    if (!alive.current) return;
    setPanel(null);
    setPicked(null);
    setScreenshot(null);
    showNotice({ kind: "sent", agent: agentLabel(agent) }, true);
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
  const button = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    options: { disabled?: boolean; pressed?: boolean; className?: string } = {},
  ) => (
    <button
      type="button"
      className={`${styles.iconButton} ${options.className ?? ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={options.disabled}
      aria-pressed={options.pressed}
    >
      {icon}
    </button>
  );

  const errorsLabel = errors.count === 1 ? "1 console error" : `${errors.count} console errors`;
  const placeholder = pendingTarget ? `Enter your ${TARGET_LABEL[pendingTarget]} URL` : "Search or enter address";

  return (
    <div
      className={styles.root}
      data-browser-id={content.browserId}
      data-loading={state?.loading ? "true" : undefined}
      onPointerDown={onRequestFocus}
    >
      <div className={styles.toolbar} role="toolbar" aria-label="Browser controls">
        <div className={styles.navigation}>
          {button("Back", <ArrowLeft size={15} />, () => action("back"), { disabled: !state })}
          {button("Forward", <ArrowRight size={15} />, () => action("forward"), { disabled: !state })}
          {state?.loading
            ? button("Stop loading", <X size={15} />, () => action("stop"))
            : button("Reload", <RotateCw size={14} />, () => action("reload"), { disabled: !state })}
        </div>
        <form className={styles.addressForm} onSubmit={submit} data-pending={pendingTarget ?? undefined}>
          <span className={styles.addressGlyph}>
            <AddressGlyph url={currentUrl} />
          </span>
          <label className={styles.srOnly} htmlFor={`browser-address-${content.browserId}`}>
            Web address
          </label>
          <input
            id={`browser-address-${content.browserId}`}
            ref={addressInput}
            className={styles.address}
            value={address}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setAddress(event.currentTarget.value)}
            onFocus={(event) => {
              addressEditing.current = true;
              onRequestFocus();
              event.currentTarget.select();
            }}
            onBlur={() => {
              addressEditing.current = false;
              if (pendingTarget && !address.trim()) setPendingTarget(null);
              if (state?.url && !pendingTarget) setAddress(state.url);
            }}
          />
          <span className={styles.progress} aria-hidden="true" />
        </form>
        <FavoriteToggle target={{ kind: "browser", id: currentUrl, workspaceId }} title={state?.title || currentUrl}>
          <span>
            <FavoriteButton
              target={{ kind: "browser", id: currentUrl, workspaceId }}
              title={state?.title || currentUrl}
            />
          </span>
        </FavoriteToggle>
        <fieldset className={styles.targets}>
          <legend className={styles.srOnly}>Environment</legend>
          {LIVE_BROWSER_TARGETS.map((target) => {
            const resolved = targets[target];
            return (
              <button
                key={target}
                type="button"
                className={styles.target}
                data-target={target}
                data-unset={resolved.url ? undefined : "true"}
                aria-pressed={activeTarget === target}
                title={
                  resolved.url
                    ? `${TARGET_LABEL[target]}: ${resolved.url}${resolved.source ? ` (${resolved.source})` : ""}`
                    : `Set your ${TARGET_LABEL[target]} URL`
                }
                onClick={() => chooseTarget(target)}
              >
                <span className={styles.targetDot} aria-hidden="true" />
                {TARGET_LABEL[target]}
              </button>
            );
          })}
        </fieldset>
        <span className={styles.selectShell}>
          <Monitor size={13} aria-hidden="true" />
          <select
            className={styles.preset}
            aria-label="Responsive viewport"
            value={preset}
            onChange={(event) => setPreset(event.currentTarget.value as ViewportPreset)}
          >
            {(Object.keys(PRESET_LABEL) as ViewportPreset[]).map((value) => (
              <option key={value} value={value}>
                {PRESET_LABEL[value]}
              </option>
            ))}
          </select>
        </span>
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
        <span className={styles.tools}>
          <span className={styles.divider} aria-hidden="true" />
          {button(picking ? "Stop picking" : "Pick an element", <Crosshair size={14} />, togglePicking, {
            disabled: !state,
            pressed: picking,
          })}
          {button(
            capturing ? "Taking screenshot" : "Take screenshot",
            capturing ? <LoaderCircle size={14} className={styles.spinner} /> : <Camera size={14} />,
            takeScreenshot,
            { disabled: !state || capturing },
          )}
          {errors.count > 0 ? (
            <button
              type="button"
              className={styles.errorBadge}
              aria-label={errorsLabel}
              title={errorsLabel}
              aria-pressed={panel === "errors"}
              onClick={() => setPanel(panel === "errors" ? null : "errors")}
            >
              <TriangleAlert size={13} aria-hidden="true" />
              {errors.count > 99 ? "99+" : errors.count}
            </button>
          ) : null}
          {copied
            ? button("URL copied", <Check size={14} />, copyUrl)
            : button("Copy URL", <Copy size={14} />, copyUrl)}
          {button("Open externally", <ExternalLink size={14} />, () => openExternally())}
        </span>
        <button
          type="button"
          className={styles.askButton}
          aria-pressed={panel === "ask"}
          aria-label="Ask Agent"
          title="Ask a coding agent about this page"
          onClick={() => setPanel(panel === "ask" ? null : "ask")}
          disabled={!state}
        >
          <Sparkles size={14} aria-hidden="true" />
          <span className={styles.askButtonLabel}>Ask Agent</span>
        </button>
        <span className={styles.rowBreak} aria-hidden="true" />
      </div>
      {notice ? (
        <NoticeBar
          notice={notice}
          onCancelPicking={togglePicking}
          onContinueExternally={() => openExternally(lastSiteUrl.current ?? currentUrl)}
          onOpenPopupHere={(url) => {
            if (notice.kind === "auth") setDismissedAuth(notice.key);
            navigateTo(url);
          }}
          onDismiss={() => {
            if (notice.kind === "auth") setDismissedAuth(notice.key);
            showNotice(null);
          }}
          onReveal={(path) =>
            void bridge
              .revealScreenshot(path)
              .catch(() => showNotice({ kind: "error", text: "KalCode couldn't show the screenshot." }, true))
          }
          onAskWithScreenshot={() => {
            showNotice(null);
            setPanel("ask");
          }}
        />
      ) : null}
      {panel === "errors" ? (
        <section className={styles.errorsPanel} aria-label="Console errors">
          <header className={styles.panelHead}>
            <span className={styles.panelTitle}>
              <TriangleAlert size={13} aria-hidden="true" />
              {errorsLabel}
            </span>
            <button type="button" className={styles.textButton} onClick={() => setPanel("ask")}>
              <Sparkles size={13} aria-hidden="true" />
              Ask an agent to fix
            </button>
            {button("Close console errors", <X size={14} />, () => setPanel(null))}
          </header>
          <ol className={styles.errorList}>
            {errors.list.map((entry, index) => (
              // Entries are page text; duplicates are legitimate, so position completes the key.
              // biome-ignore lint/suspicious/noArrayIndexKey: errors are an ordered, append-only list.
              <li key={`${index}:${entry}`}>{entry}</li>
            ))}
          </ol>
        </section>
      ) : null}
      {panel === "ask" ? (
        <BrowserAsk
          workspaceId={workspaceId}
          services={services}
          preferredAgentId={preferredAgentId}
          page={{ url: currentUrl, title: state?.title ?? null }}
          picked={picked}
          errors={errors.list}
          errorCount={errors.count}
          screenshot={screenshot}
          capturing={capturing}
          picking={picking}
          onPick={togglePicking}
          onScreenshot={takeScreenshot}
          onRemovePicked={() => setPicked(null)}
          onRemoveScreenshot={() => setScreenshot(null)}
          onSend={askAgent}
          onClose={() => setPanel(null)}
        />
      ) : null}
      <div className={styles.stage} data-framed={preset === "fluid" ? undefined : "true"}>
        {preset === "fluid" ? null : (
          <span className={styles.deviceLabel} aria-hidden="true">
            {preset === "custom" ? `Custom · ${customWidth}` : PRESET_LABEL[preset]} px
          </span>
        )}
        <button
          type="button"
          ref={setViewport}
          className={styles.viewport}
          style={{ width: desiredWidth, padding: 0, color: "inherit", font: "inherit" }}
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
          ) : !state ? (
            <span className={styles.opening}>
              <span className={styles.openingGlyph} aria-hidden="true">
                <Globe size={20} />
              </span>
              <span className={styles.openingText}>Opening {hostOf(attachUrl.current)}…</span>
            </span>
          ) : null}
        </button>
        {attachFailure ? (
          <div className={styles.failure} role="alert">
            <span className={styles.failureGlyph} aria-hidden="true">
              <ShieldAlert size={20} />
            </span>
            <p className={styles.failureTitle}>KalCode couldn't open this browser pane.</p>
            <p className={styles.failureReason}>{attachFailure}</p>
            <div className={styles.failureActions}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => {
                  setAttachFailure(null);
                  setError(null);
                  setAttachAttempt((n) => n + 1);
                }}
              >
                Retry
              </button>
              <button type="button" className={styles.ghostButton} onClick={() => openExternally()}>
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
            <span className={styles.statusDot} data-state={attachFailure ? "failed" : state ? "ready" : "opening"} />
          )}
          {footerLabel}
        </span>
        <span className={styles.statusUrl}>{state?.url ?? address}</span>
        {errors.count > 0 ? <span className={styles.statusErrors}>{errorsLabel}</span> : null}
      </footer>
    </div>
  );
}

function NoticeBar({
  notice,
  onCancelPicking,
  onContinueExternally,
  onOpenPopupHere,
  onDismiss,
  onReveal,
  onAskWithScreenshot,
}: {
  notice: Notice;
  onCancelPicking: () => void;
  onContinueExternally: () => void;
  onOpenPopupHere: (url: string) => void;
  onDismiss: () => void;
  onReveal: (path: string) => void;
  onAskWithScreenshot: () => void;
}) {
  const dismiss = (
    <button type="button" className={styles.noticeClose} aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
      <X size={13} />
    </button>
  );
  if (notice.kind === "picking") {
    return (
      <div className={styles.notice} data-tone="accent" role="status">
        <Crosshair size={14} aria-hidden="true" className={styles.noticeIcon} />
        <span className={styles.noticeText}>
          <strong>Click any element on the page.</strong> It's attached to Ask Agent. Esc cancels.
        </span>
        <button type="button" className={styles.textButton} onClick={onCancelPicking}>
          Cancel
        </button>
      </div>
    );
  }
  if (notice.kind === "screenshot") {
    return (
      <div className={styles.notice} data-tone="success" role="status">
        <Camera size={14} aria-hidden="true" className={styles.noticeIcon} />
        <span className={styles.noticeText}>
          <strong>Screenshot saved.</strong>
          <span className={styles.noticeFile}>{notice.shot.fileName}</span>
        </span>
        <button type="button" className={styles.textButton} onClick={() => onReveal(notice.shot.path)}>
          <FolderOpen size={13} aria-hidden="true" />
          Show in folder
        </button>
        <button type="button" className={styles.textButton} onClick={onAskWithScreenshot}>
          <Sparkles size={13} aria-hidden="true" />
          Ask with it
        </button>
        {dismiss}
      </div>
    );
  }
  if (notice.kind === "sent") {
    return (
      <div className={styles.notice} data-tone="success" role="status">
        <Check size={14} aria-hidden="true" className={styles.noticeIcon} />
        <span className={styles.noticeText}>
          <strong>Sent to {notice.agent}.</strong> The page context went to its terminal.
        </span>
        {dismiss}
      </div>
    );
  }
  if (notice.kind === "error") {
    return (
      <div className={styles.notice} data-tone="danger" role="alert">
        <TriangleAlert size={14} aria-hidden="true" className={styles.noticeIcon} />
        <span className={styles.noticeText}>{notice.text}</span>
        {dismiss}
      </div>
    );
  }
  const { auth } = notice;
  if (auth.kind === "popup_blocked") {
    return (
      <div className={styles.notice} data-tone="waiting" role="status">
        <LogIn size={14} aria-hidden="true" className={styles.noticeIcon} />
        <span className={styles.noticeText}>
          {auth.signIn ? (
            <>
              <strong>{auth.host} wants to open a sign-in window.</strong> Pop-ups can't open inside KalCode. Continue
              in your browser to sign in safely.
            </>
          ) : (
            <>
              <strong>{auth.host} tried to open a new window.</strong> Pop-ups stay blocked in Live Browser.
            </>
          )}
        </span>
        <button type="button" className={styles.noticeAction} onClick={onContinueExternally}>
          <ExternalLink size={13} aria-hidden="true" />
          Continue in browser
        </button>
        <button type="button" className={styles.textButton} onClick={() => onOpenPopupHere(auth.url)}>
          Open here
        </button>
        {dismiss}
      </div>
    );
  }
  return (
    <div className={styles.notice} data-tone={auth.kind === "google_blocked" ? "danger" : "waiting"} role="status">
      {auth.kind === "google_blocked" ? (
        <ShieldAlert size={14} aria-hidden="true" className={styles.noticeIcon} />
      ) : (
        <LogIn size={14} aria-hidden="true" className={styles.noticeIcon} />
      )}
      <span className={styles.noticeText}>
        {auth.kind === "google_blocked" ? (
          <>
            <strong>Google blocked sign-in in this embedded browser.</strong> That's Google's security policy. Continue
            in your browser; KalCode never sees your password.
          </>
        ) : (
          <>
            <strong>Signing in with Google?</strong> Google may refuse embedded browsers. If it does, continue in your
            browser; KalCode never sees your password.
          </>
        )}
      </span>
      <button type="button" className={styles.noticeAction} onClick={onContinueExternally}>
        <ExternalLink size={13} aria-hidden="true" />
        Continue in browser
      </button>
      {dismiss}
    </div>
  );
}
