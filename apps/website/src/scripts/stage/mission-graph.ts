/**
 * MissionGraph: plays the run once when the graph is well in view (objective → parallel agents →
 * verify → collapse to the verified result), with light travelling along each path as work hands
 * over. Hover or focus a node to reveal what it depends on and what it unblocks. Paused offscreen;
 * reduced motion keeps the finished graph.
 */
import { MISSION_GRAPH } from "../../data/story";
import { announce, qsa, reducedMotion, Scheduler, watchVisibility, whenNear } from "./util";

type NodeState = "waiting" | "active" | "done";

function closure(start: string, dir: "up" | "down"): Set<string> {
  const seen = new Set<string>();
  const walk = (n: string) => {
    for (const [from, to] of MISSION_GRAPH.edges) {
      const next = dir === "up" ? (to === n ? from : null) : from === n ? to : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        walk(next);
      }
    }
  };
  walk(start);
  return seen;
}

function wire(root: HTMLElement): void {
  root.dataset.kcWired = "true";
  const board = root.querySelector<HTMLElement>("[data-kc-mg-board]");
  const svg = root.querySelector<SVGSVGElement>(".kc-mg__edges");
  const live = root.querySelector("[data-kc-mg-live]");
  if (!board || !svg) return;
  const sched = new Scheduler();
  const nodes = qsa(root, "[data-node]");
  const edges = qsa<SVGPathElement>(root, ".kc-mg__edge");
  const pulses = qsa<SVGCircleElement>(root, ".kc-mg__pulse");

  const setNode = (id: string, state: NodeState) => {
    const el = nodes.find((n) => n.dataset.node === id);
    if (el) el.dataset.state = state;
  };
  const setEdges = (pred: (from: string, to: string) => boolean, state: string) => {
    for (const e of edges) if (pred(e.dataset.from ?? "", e.dataset.to ?? "")) e.dataset.state = state;
  };
  const pulse = (from: string) => {
    if (reducedMotion()) return;
    for (const p of pulses) {
      if (p.dataset.from !== from) continue;
      const anim = p.querySelector("animateMotion") as (SVGAnimationElement & { beginElement(): void }) | null;
      p.dataset.on = "true";
      anim?.beginElement();
      window.setTimeout(() => p.removeAttribute("data-on"), 1000);
    }
  };

  const reset = () => {
    sched.cancel();
    root.dataset.stage = "running";
    for (const n of nodes) n.dataset.state = "waiting";
    for (const e of edges) e.dataset.state = "off";
  };

  const run = () => {
    reset();
    const { schedule } = MISSION_GRAPH;
    for (const [id, [start, end]] of Object.entries(schedule)) {
      sched.after(start, () => {
        setNode(id, "active");
        setEdges((_, to) => to === id, "on");
      });
      sched.after(end, () => {
        setNode(id, "done");
        setEdges((_, to) => to === id, "done");
        pulse(id);
        setEdges((from) => from === id, "ready");
      });
    }
    const last = Math.max(...Object.values(schedule).map(([, end]) => end));
    sched.after(last + 350, () => {
      root.dataset.stage = "verified";
      announce(
        live,
        `Verified: ${MISSION_GRAPH.checks.length} checks passed. The production deploy waits for your approval.`,
      );
    });
  };

  // Dependencies on hover and focus.
  const focusNode = (id: string | null) => {
    if (!id) {
      board.removeAttribute("data-focus");
      for (const n of nodes) n.removeAttribute("data-rel");
      for (const e of edges) e.removeAttribute("data-rel");
      return;
    }
    const up = closure(id, "up");
    const down = closure(id, "down");
    board.dataset.focus = id;
    for (const n of nodes) {
      const k = n.dataset.node ?? "";
      if (k === id) n.dataset.rel = "self";
      else if (up.has(k)) n.dataset.rel = "up";
      else if (down.has(k)) n.dataset.rel = "down";
      else n.removeAttribute("data-rel");
    }
    for (const e of edges) {
      const f = e.dataset.from ?? "";
      const t = e.dataset.to ?? "";
      if ((up.has(f) || f === id) && (up.has(t) || t === id)) e.dataset.rel = "up";
      else if ((down.has(t) || t === id) && (down.has(f) || f === id)) e.dataset.rel = "down";
      else e.removeAttribute("data-rel");
    }
  };
  board.addEventListener("pointerover", (e) => {
    const n = (e.target as HTMLElement).closest<HTMLElement>("[data-kc-mg-node]");
    if (n) focusNode(n.dataset.kcMgNode ?? null);
  });
  board.addEventListener("pointerleave", () => {
    if (!board.contains(document.activeElement)) focusNode(null);
  });
  board.addEventListener("focusin", (e) => {
    const n = (e.target as HTMLElement).closest<HTMLElement>("[data-kc-mg-node]");
    if (n) focusNode(n.dataset.kcMgNode ?? null);
  });
  board.addEventListener("focusout", (e) => {
    if (!board.contains(e.relatedTarget as Node | null)) focusNode(null);
  });

  root.querySelector("[data-kc-mg-replay]")?.addEventListener("click", () => {
    if (reducedMotion()) return;
    run();
    announce(live, "Mission started again.");
  });

  watchVisibility(root, (visible) => {
    if (visible) {
      sched.resume();
      svg.unpauseAnimations?.();
    } else {
      sched.pause();
      svg.pauseAnimations?.();
    }
  });

  if (reducedMotion()) return;
  // Play once the board is well in view.
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      run();
    },
    { threshold: 0.45 },
  );
  // The finished graph stays on screen until the board is well in view; the run then replays it
  // (every node and path stays visible throughout, only their light changes).
  io.observe(board);
}

for (const root of qsa(document, "[data-kc-mg]")) whenNear(root, () => wire(root));
