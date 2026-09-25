/**
 * WebGL renderer for the hero orb, loaded by ./orb.ts after the page has loaded. Initialisation
 * is split into short steps (background shader compile, off-thread image decode, one texture
 * upload per frame) so it never produces a long task. One canvas, two draws per frame.
 */
import { BLOOM_URL, ENTRY_Y, FX_URL, SPHERE_X } from "./meta";
import { BEAM_FS, BEAM_VS, ORB_FS, ORB_VS } from "./shaders";

export interface OrbOptions {
  /** Lower-cost variant: smaller backing store, no motes, no pointer parallax. */
  lite: boolean;
}

export interface OrbRenderer {
  /** Advance the animation by `dt` seconds and draw. */
  frame(dt: number): void;
  /** Draw one composed still (reduced motion). */
  still(): void;
  layout(layout: Layout): void;
  setPointer(x: number, y: number): void;
  setScroll(progress: number): void;
  setInk(ink: number): void;
  /** Quality ladder step down; returns false when already at the floor. */
  degrade(): boolean;
  destroy(): void;
}

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const PERIOD = 8.4; // seconds between energy surges
const RISE = 1.9; // seconds for a surge to climb the stream
const TAU = Math.PI * 2;

/** Yield to the browser: next frame, then a macrotask, so each init step is its own short task. */
const breathe = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/**
 * Decodes an image off the main thread (fetch + createImageBitmap). Data layers are decoded raw
 * (no colour management, no premultiplication); the symbol is premultiplied for blending.
 * Falls back to an <img> decode where ImageBitmap options are unsupported.
 */
async function bitmap(url: string, data: boolean): Promise<TexImageSource> {
  try {
    const blob = await (await fetch(url)).blob();
    return await createImageBitmap(blob, {
      premultiplyAlpha: data ? "none" : "premultiply",
      colorSpaceConversion: data ? "none" : "default",
    });
  } catch {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }
}

interface Program {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface Started {
  program: WebGLProgram;
  shaders: WebGLShader[];
}

/** Starts compiling and linking without querying status (no synchronous wait). */
function startProgram(gl: GL, vs: string, fs: string): Started {
  const program = gl.createProgram();
  if (!program) throw new Error("program");
  const shaders: WebGLShader[] = [];
  const sources: Array<[number, string]> = [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ];
  for (const [type, source] of sources) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    shaders.push(shader);
  }
  gl.bindAttribLocation(program, 0, "aPos");
  gl.linkProgram(program);
  return { program, shaders };
}

function finishProgram(gl: GL, started: Started, names: string[]): Program {
  const { program, shaders } = started;
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = shaders.map((sh) => gl.getShaderInfoLog(sh)).join(" ");
    throw new Error(`${gl.getProgramInfoLog(program) ?? "link"} ${log}`);
  }
  for (const sh of shaders) gl.deleteShader(sh);
  const u: Program["u"] = {};
  for (const name of names) u[name] = gl.getUniformLocation(program, name);
  return { program, u };
}

function texture(gl: GL, source: TexImageSource, data: boolean, mips: boolean): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // These only affect the <img> fallback; ImageBitmaps carry their own decode options.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !data);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, data ? gl.NONE : gl.BROWSER_DEFAULT_WEBGL);
  gl.texImage2D(gl.TEXTURE_2D, 0, data ? gl.RGB : gl.RGBA, data ? gl.RGB : gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (mips) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  return tex;
}

const isPot = (n: number) => (n & (n - 1)) === 0;

/** Row-major 3x3 rotation helpers (column-major when uploaded with transpose=false). */
type Mat3 = [number, number, number, number, number, number, number, number, number];
const rotX = (a: number): Mat3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, s, 0, -s, c];
};
const rotY = (a: number): Mat3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
};
const rotZ = (a: number): Mat3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
};
/** Column-major product a * b. */
function mul(a: Mat3, b: Mat3): Mat3 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const col = (x: number, y: number, z: number) =>
    [a0 * x + a3 * y + a6 * z, a1 * x + a4 * y + a7 * z, a2 * x + a5 * y + a8 * z] as const;
  return [...col(b[0], b[1], b[2]), ...col(b[3], b[4], b[5]), ...col(b[6], b[7], b[8])];
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Everything the renderer needs to know about the page, measured on the main thread (CSS px,
 * relative to the canvas's top-left corner, y down). The renderer itself never touches the DOM,
 * so it runs unchanged in a worker on an OffscreenCanvas.
 */
export interface Layout {
  width: number;
  height: number;
  dpr: number;
  stageX: number;
  stageY: number;
  stageSize: number;
  /** Text-safe band: top, bottom (from the canvas top), level inside, level below; or null. */
  band: [number, number, number, number] | null;
  /** Where the stream starts (the platform ring centre, or the canvas bottom), from the canvas top-left. */
  originX: number;
  originY: number;
  /** Radius of the platform's outer ring (0 when there is no platform). */
  platformRadius: number;
}

type Canvas = HTMLCanvasElement | OffscreenCanvas;

export async function createOrb(canvas: Canvas, baseUrl: string, options: OrbOptions): Promise<OrbRenderer> {
  const attrs: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: options.lite ? "low-power" : "default",
  };
  const gl = (canvas.getContext("webgl2", attrs) ?? canvas.getContext("webgl", attrs)) as GL | null;
  if (!gl) throw new Error("webgl");
  const gl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  if (gl.isContextLost()) throw new Error("lost");

  // Software rasterisers (blocklisted GPUs, some VMs) burn CPU on every frame: keep the CSS
  // version there instead.
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(rendererName)) throw new Error("software");

  // Step 1: start both programs compiling (in the background where KHR_parallel_shader_compile
  // exists) while the images decode off the main thread.
  const parallel = gl.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;
  const beamStart = startProgram(gl, BEAM_VS, BEAM_FS);
  const orbStart = startProgram(gl, ORB_VS, ORB_FS);
  const images = Promise.all([bitmap(baseUrl, false), bitmap(FX_URL, true), bitmap(BLOOM_URL, true)]);
  if (parallel) {
    const done = (p: WebGLProgram) => gl.getProgramParameter(p, parallel.COMPLETION_STATUS_KHR) === true;
    while (!(done(beamStart.program) && done(orbStart.program))) await breathe();
  } else {
    await breathe();
  }
  const beam = finishProgram(gl, beamStart, [
    "uRect",
    "uRes",
    "uPx",
    "uInk",
    "uQ",
    "uBeam",
    "uSurge",
    "uPh",
    "uBand",
    "uOrigin",
  ]);
  await breathe();
  const orb = finishProgram(gl, orbStart, [
    "uRes",
    "uOrb",
    "uTilt",
    "uPx",
    "uInk",
    "uQ",
    "uBase",
    "uFx",
    "uBloom",
    "uCyc",
    "uPh",
    "uR1u",
    "uR1v",
    "uR2u",
    "uR2v",
    "uRing",
  ]);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // Step 2: one texture upload per frame.
  const [baseImg, fxImg, bloomImg] = await images;
  await breathe();
  const baseWidth = "width" in baseImg ? Number(baseImg.width) : 0;
  const baseTex = texture(gl, baseImg, false, gl2 || isPot(baseWidth));
  await breathe();
  const fxTex = texture(gl, fxImg, true, true);
  await breathe();
  const bloomTex = texture(gl, bloomImg, true, false);
  for (const img of [baseImg, fxImg, bloomImg]) if (img instanceof ImageBitmap) img.close();

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  // Quality ladder: [device-pixel cap, detail]. Lite starts lower.
  const ladder: Array<[number, number]> = [
    [2, 1],
    [1.5, 1],
    [1.25, 0],
    [1, 0],
    [0.75, 0],
  ];
  let step = options.lite ? 2 : 0;

  let time = 3.2; // start mid-cycle so the first frame already shows a lit network
  let ink = 0;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  let scroll = 0;
  let px = 1;
  const geo = { w: 1, h: 1, cx: 0, cy: 0, s: 1, bx: 0, by: 0, ox: 0, oy: 0, pr: 0 };
  /** Text-safe band: top y, bottom y (canvas px, y up), level inside, level below. */
  let band: [number, number, number, number] = [0, 0, 1, 1];

  let lay: Layout = {
    width: 1,
    height: 1,
    dpr: 1,
    stageX: 0,
    stageY: 0,
    stageSize: 1,
    band: null,
    originX: 0,
    originY: 1,
    platformRadius: 0,
  };

  function apply() {
    const [cap] = ladder[step] ?? [1, 0];
    px = Math.min(lay.dpr || 1, cap);
    const w = Math.max(1, Math.round(lay.width * px));
    const h = Math.max(1, Math.round(lay.height * px));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const sx = w / Math.max(1, lay.width);
    const sy = h / Math.max(1, lay.height);
    const size = lay.stageSize;
    geo.w = w;
    geo.h = h;
    geo.s = size * sx;
    geo.cx = (lay.stageX + size / 2) * sx;
    geo.cy = h - (lay.stageY + size / 2) * sy;
    geo.bx = (lay.stageX + size * SPHERE_X) * sx;
    geo.by = h - (lay.stageY + size * ENTRY_Y) * sy;
    geo.ox = lay.originX * sx;
    geo.oy = h - lay.originY * sy;
    geo.pr = lay.platformRadius * sx;
    band = lay.band ? [h - lay.band[0] * sy, h - lay.band[1] * sy, lay.band[2], lay.band[3]] : [0, 0, 1, 1];
    gl?.viewport(0, 0, w, h);
  }

  /**
   * A ring: a circle seen at a steep angle whose orientation and opening wobble slowly (never
   * edge-on), so it reads as an orbit moving in its own depth plane rather than a 2D spinner.
   */
  function ringBasis(
    t: number,
    radius: number,
    angle: number,
    tilt: number,
    wobble: [number, number, number, number],
    tiltM: Mat3,
  ) {
    const [amp, openAmp, w1, w2] = wobble;
    const m = mul(tiltM, mul(rotZ(angle + amp * Math.sin(w1 * t)), rotX(tilt + openAmp * Math.sin(w2 * t + 1.7))));
    const r = radius * geo.s;
    return {
      u: [m[0] * r, m[1] * r, m[2] * r],
      v: [m[3] * r, m[4] * r, m[5] * r],
    };
  }

  function draw(t: number) {
    if (!gl) return;
    const [, detail] = ladder[step] ?? [1, 0];
    const q = options.lite ? Math.min(detail, 0.4) : detail;

    // Cycle: a surge climbs the stream (RISE s), arrives, and the front spreads through the art.
    const n = Math.floor(t / PERIOD);
    const tc = t - n * PERIOD;
    let tau = tc - RISE;
    let seed = n;
    if (tau < 0) {
      tau += PERIOD;
      seed = n - 1;
    }
    const strength = 0.78 + 0.22 * Math.abs(Math.sin(seed * 12.9898 + 1.3));
    const speed = 0.9 + 0.2 * Math.abs(Math.sin(seed * 4.1414 + 0.7));
    const reach = 1 - (1 - Math.min(1, (tau * speed) / 3.8)) ** 2;
    const front = -0.04 + 1.12 * reach;
    const env = smooth(0, 0.35, tau) * (1 - smooth(3.2, 6.2, tau)) * strength;
    const arrival = smooth(-0.2, 0.15, tau) * Math.exp(-Math.max(0, tau) * 1.9) * strength;
    const surgePos = Math.min(1, tc / RISE) ** 1.25;
    const surgeVis = smooth(0, 0.25, tc) * (1 - smooth(RISE - 0.1, RISE + 0.25, tc));

    // Pointer parallax (eased), plus a small backward lean as the hero scrolls away.
    pointer.x += (pointer.tx - pointer.x) * 0.06;
    pointer.y += (pointer.ty - pointer.y) * 0.06;
    const lean = scroll * 0.12;
    const tiltM = mul(rotX(pointer.y * 0.05 + lean), rotY(pointer.x * 0.06));
    const ringTilt = mul(rotX(pointer.y * 0.1 + lean * 1.5), rotY(pointer.x * 0.12));

    const flicker = 1 + 0.035 * Math.sin(t * 1.7) + 0.025 * Math.sin(t * 2.9 + 1.1);
    const beamI = flicker * (1 - scroll * 0.35);

    gl.clear(gl.COLOR_BUFFER_BIT);

    // 1. Beam
    const s = geo.s;
    const halfW = Math.max(s * 0.75, geo.pr * 1.1);
    gl.useProgram(beam.program);
    gl.uniform4f(
      beam.u.uRect ?? null,
      geo.bx - halfW,
      Math.max(0, geo.oy - Math.max(geo.pr * 0.12, s * 0.12)),
      geo.bx + halfW,
      geo.by + s * 0.03,
    );
    gl.uniform2f(beam.u.uRes ?? null, geo.w, geo.h);
    gl.uniform1f(beam.u.uPx ?? null, px);
    gl.uniform1f(beam.u.uInk ?? null, ink);
    gl.uniform1f(beam.u.uQ ?? null, q);
    gl.uniform4f(beam.u.uBeam ?? null, geo.bx, Math.max(1, geo.by), s, beamI);
    gl.uniform4f(beam.u.uSurge ?? null, surgePos, surgeVis * strength, 0, 0);
    gl.uniform4f(beam.u.uPh ?? null, (t * 0.55) % 64, (t * 2.4) % 64, 0, 0);
    gl.uniform4f(beam.u.uBand ?? null, ...band);
    gl.uniform4f(beam.u.uOrigin ?? null, geo.ox, geo.oy, geo.pr, tc < RISE ? tc / RISE : 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2. Orb
    gl.useProgram(orb.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, baseTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fxTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bloomTex);
    gl.uniform1i(orb.u.uBase ?? null, 0);
    gl.uniform1i(orb.u.uFx ?? null, 1);
    gl.uniform1i(orb.u.uBloom ?? null, 2);
    gl.uniform2f(orb.u.uRes ?? null, geo.w, geo.h);
    gl.uniform4f(orb.u.uOrb ?? null, geo.cx, geo.cy, s, s * 2.6);
    gl.uniformMatrix3fv(orb.u.uTilt ?? null, false, tiltM);
    gl.uniform1f(orb.u.uPx ?? null, px);
    gl.uniform1f(orb.u.uInk ?? null, ink);
    gl.uniform1f(orb.u.uQ ?? null, q);
    gl.uniform4f(orb.u.uCyc ?? null, front, env, arrival, seed % 97);
    gl.uniform4f(
      orb.u.uPh ?? null,
      (t / 7) % 1,
      (t * 0.32) % 1,
      (t * 0.045) % 4096,
      0.5 + 0.5 * Math.sin((t / 11) * TAU),
    );
    const r1 = ringBasis(t, 0.5, -0.28, 1.24, [0.22, 0.12, TAU / 53, TAU / 71], ringTilt);
    const r2 = ringBasis(t, 0.41, 0.42, 1.12, [0.25, 0.14, -TAU / 67, TAU / 83], ringTilt);
    gl.uniform3fv(orb.u.uR1u ?? null, r1.u);
    gl.uniform3fv(orb.u.uR1v ?? null, r1.v);
    gl.uniform3fv(orb.u.uR2u ?? null, r2.u);
    gl.uniform3fv(orb.u.uR2v ?? null, r2.v);
    gl.uniform4f(orb.u.uRing ?? null, (t * (TAU / 14)) % TAU, (-t * (TAU / 19) + 2.2) % TAU, 0.2, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  return {
    frame(dt) {
      time += dt;
      draw(time);
    },
    still() {
      pointer.x = pointer.tx = 0;
      pointer.y = pointer.ty = 0;
      draw(RISE + 1.55);
    },
    layout(next) {
      lay = next;
      apply();
    },
    setPointer(x, y) {
      pointer.tx = x;
      pointer.ty = y;
    },
    setScroll(progress) {
      scroll = Math.min(1, Math.max(0, progress));
    },
    setInk(value) {
      ink = value;
    },
    degrade() {
      if (step >= ladder.length - 1) return false;
      step += 1;
      apply();
      return true;
    },
    destroy() {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

export interface LoopHooks {
  /** First frame drawn (fade the canvas in over the poster). */
  live(): void;
  /** Quality floor reached and still too slow: hand back to the CSS version. */
  fallback(): void;
}

export interface Loop {
  start(): void;
  stop(): void;
  still(): void;
}

const SLOW_FRAME = 1 / 45;

/**
 * The animation loop plus a frame-time watchdog (1.5 s windows; below ~45 fps it steps the
 * quality ladder down, and at the floor it gives up). Works in a window or a worker.
 */
export function createLoop(orb: OrbRenderer, hooks: LoopHooks): Loop {
  const g = globalThis as typeof globalThis & {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const raf = (cb: FrameRequestCallback): number =>
    g.requestAnimationFrame ? g.requestAnimationFrame(cb) : Number(setTimeout(() => cb(performance.now()), 16));
  const caf = (id: number) => (g.cancelAnimationFrame ? g.cancelAnimationFrame(id) : clearTimeout(id));
  let id = 0;
  let last = 0;
  let windowStart = 0;
  let windowFrames = 0;
  let calm = 0;
  let shown = false;

  const show = () => {
    if (shown) return;
    shown = true;
    hooks.live();
  };

  function stop() {
    if (id) caf(id);
    id = 0;
  }

  function tick(now: number) {
    id = raf(tick);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    orb.frame(dt);
    show();
    if (calm >= 3) return;
    if (!windowStart) windowStart = now;
    windowFrames += 1;
    if (now - windowStart > 1500) {
      const slow = (now - windowStart) / 1000 / windowFrames > SLOW_FRAME;
      windowStart = now;
      windowFrames = 0;
      if (!slow) calm += 1;
      else if (orb.degrade()) calm = 0;
      else {
        stop();
        hooks.fallback();
      }
    }
  }

  return {
    start() {
      if (id) return;
      last = 0;
      windowStart = 0;
      windowFrames = 0;
      id = raf(tick);
    },
    stop,
    still() {
      stop();
      orb.still();
      show();
    },
  };
}
