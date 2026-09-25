/**
 * KalVoiceStage: listening (orb and waveform react, the words appear) → processing (planning) →
 * executing (Claude Code implementing, Codex reviewing, tests passing) → done. Plays once when in
 * view; press and hold the on-screen key (or F8 while focus is inside the stage, never globally)
 * to play it again; "Type it instead" stops the run. Paused offscreen; reduced motion keeps the
 * finished still.
 */
import { VOICE, VOICE_FLOW } from "../../data/story";
import { announce, qsa, reducedMotion, Scheduler, watchVisibility, whenNear } from "./util";

type Widget = "off" | "listening" | "processing" | "executing" | "done";
const LABEL: Record<Widget, string> = {
  off: "Ready",
  listening: "Listening",
  processing: "Processing",
  executing: "Executing",
  done: "Done",
};

function wire(root: HTMLElement): void {
  root.dataset.kcWired = "true";
  const sched = new Scheduler();
  const live = root.querySelector("[data-kc-vs-live]");
  const label = root.querySelector("[data-kc-vs-label]");
  const text = root.querySelector<HTMLElement>("[data-kc-vs-text]");
  const result = root.querySelector("[data-kc-vs-result]");
  const key = root.querySelector<HTMLElement>("[data-kc-vs-hold]");
  const bars = qsa(root, "[data-kc-vs-wave] .kc-wave__bar");
  const orb = root.querySelector<HTMLElement>("[data-kc-vs-orb]");
  const steps = qsa(root, ".kc-vs__step");
  let visible = false;
  let wave: number | undefined;
  let holdStart = 0;
  let holding = false;
  let busy = false;

  const setWidget = (w: Widget) => {
    root.dataset.state = w;
    if (label) label.textContent = LABEL[w];
  };
  /** Steps before `id` are done, `id` is active, the rest are queued; "done" completes all. */
  const setStep = (id: string | null) => {
    root.dataset.step = id ?? "none";
    const index = steps.findIndex((s) => s.dataset.step === id);
    steps.forEach((s, i) => {
      s.dataset.state =
        id === "done" ? "done" : index < 0 ? "queued" : i < index ? "done" : i === index ? "active" : "queued";
    });
  };

  const startWave = () => {
    stopWave();
    if (!bars.length || reducedMotion()) return;
    const amps = VOICE.amplitudes;
    const t0 = performance.now();
    const frame = (now: number) => {
      if (visible) {
        const pos = (now - t0) / 40;
        bars.forEach((bar, i) => {
          const a = amps[Math.floor(pos + i * 1.3) % amps.length] ?? 0.2;
          const b = amps[Math.floor(pos + i * 1.3 + 1) % amps.length] ?? a;
          bar.style.transform = `scaleY(${Math.max(0.12, a + (b - a) * (pos % 1)).toFixed(3)})`;
        });
        if (orb) orb.style.transform = `scale(${(1 + (amps[Math.floor(pos) % amps.length] ?? 0) * 0.05).toFixed(3)})`;
      }
      wave = requestAnimationFrame(frame);
    };
    wave = requestAnimationFrame(frame);
  };
  const stopWave = () => {
    if (wave !== undefined) cancelAnimationFrame(wave);
    wave = undefined;
    for (const b of bars) b.style.removeProperty("transform");
    orb?.style.removeProperty("transform");
  };

  const words = VOICE_FLOW.phrase.split(" ");
  const listen = () => {
    sched.cancel();
    busy = true;
    setWidget("listening");
    setStep(null);
    root.removeAttribute("data-typed");
    startWave();
    if (text) text.textContent = "";
    let n = 0;
    const step = () => {
      n += 1;
      if (text) text.textContent = `“${words.slice(0, n).join(" ")}${n >= words.length ? "”" : ""}`;
      if (n < words.length) sched.after(230, step);
    };
    sched.after(300, step);
    announce(live, "KalVoice is listening.");
  };

  const run = () => {
    stopWave();
    if (text) text.textContent = `“${VOICE_FLOW.phrase}”`;
    setWidget("processing");
    let at = 0;
    VOICE_FLOW.steps.forEach((s, i) => {
      sched.after(at, () => {
        setStep(s.id);
        if (i === 1) setWidget("executing");
        announce(live, `${s.label}.`);
      });
      at += s.ms;
    });
    sched.after(at, () => {
      setStep("done");
      setWidget("done");
      if (result) result.textContent = VOICE_FLOW.done;
      busy = false;
      announce(live, VOICE_FLOW.done);
    });
  };

  const play = () => {
    if (reducedMotion()) return;
    listen();
    sched.after(VOICE_FLOW.listenMs, run);
  };

  // Press and hold: listening while held (at least long enough to hear the phrase).
  const start = () => {
    if (holding || reducedMotion()) return;
    holding = true;
    holdStart = performance.now();
    key?.setAttribute("data-holding", "");
    listen();
  };
  const end = () => {
    if (!holding) return;
    holding = false;
    key?.removeAttribute("data-holding");
    const wait = Math.max(0, VOICE_FLOW.listenMs - (performance.now() - holdStart));
    sched.after(wait, run);
  };
  if (key) {
    key.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      key.setPointerCapture?.(e.pointerId);
      start();
    });
    key.addEventListener("pointerup", end);
    key.addEventListener("pointercancel", end);
    key.addEventListener("keydown", (e) => {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) {
        e.preventDefault();
        start();
      }
    });
    key.addEventListener("keyup", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        end();
      }
    });
    key.addEventListener("click", (e) => {
      if (e.detail === 0 && !holding && !busy) play();
    });
  }
  root.addEventListener("keydown", (e) => {
    if (e.key === VOICE.key && !e.repeat) {
      e.preventDefault();
      start();
    }
  });
  root.addEventListener("keyup", (e) => {
    if (e.key === VOICE.key) {
      e.preventDefault();
      end();
    }
  });

  root.querySelector("[data-kc-vs-replay]")?.addEventListener("click", () => {
    if (!busy) play();
  });
  root.querySelector("[data-kc-vs-instead]")?.addEventListener("click", () => {
    sched.cancel();
    stopWave();
    busy = false;
    setStep("none");
    setWidget("done");
    root.dataset.typed = "true";
    if (result) result.textContent = "Typed into Claude Code instead. Nothing ran.";
    announce(live, "Typed into Claude Code instead. Nothing ran.");
  });

  watchVisibility(root, (v) => {
    visible = v;
    if (v) {
      sched.resume();
      root.removeAttribute("data-paused");
    } else {
      sched.pause();
      root.setAttribute("data-paused", "true");
    }
  });

  if (reducedMotion()) return;
  root.dataset.state = "off";
  setWidget("off");
  setStep(null);
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      if (!busy) play();
    },
    { threshold: 0.5 },
  );
  io.observe(root);
}

for (const root of qsa(document, "[data-kc-vs]")) whenNear(root, () => wire(root));
