/**
 * WebGL renderer for the hero orb. Loaded on demand by ./orb.ts (never on reduced-motion-only
 * or no-WebGL paths unless a still frame is wanted). One canvas, two draws per frame.
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
  resize(): void;
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

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  return img;
}

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "compile");
  }
  return shader;
}

interface Program {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

function link(gl: GL, vs: string, fs: string, names: string[]): Program {
  const program = gl.createProgram();
  if (!program) throw new Error("program");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(program, 0, "aPos");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "link");
  }
  const u: Program["u"] = {};
  for (const name of names) u[name] = gl.getUniformLocation(program, name);
  return { program, u };
}

function texture(gl: GL, source: TexImageSource, data: boolean, mips: boolean): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
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

export async function createOrb(
  root: HTMLElement,
  stage: HTMLElement,
  poster: HTMLImageElement,
  options: OrbOptions,
): Promise<OrbRenderer> {
  const canvas = document.createElement("canvas");
  canvas.className = "hero-orb__canvas";
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

  const [fxImg, bloomImg] = await Promise.all([loadImage(FX_URL), loadImage(BLOOM_URL), poster.decode()]);

  const beam = link(gl, BEAM_VS, BEAM_FS, ["uRect", "uRes", "uPx", "uInk", "uQ", "uBeam", "uSurge", "uPh"]);
  const orb = link(gl, ORB_VS, ORB_FS, [
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

  const baseMips = gl2 || (isPot(poster.naturalWidth) && isPot(poster.naturalHeight));
  const baseTex = texture(gl, poster, false, baseMips);
  const fxTex = texture(gl, fxImg, true, true);
  const bloomTex = texture(gl, bloomImg, true, false);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  (stage.parentElement ?? root).appendChild(canvas);

  // Quality ladder: [device-pixel cap, detail]. Lite starts lower.
  const ladder: Array<[number, number]> = [
    [2, 1],
    [1.5, 1],
    [1.25, 0],
    [1, 0],
    [0.75, 0],
  ];
  // Software rasterisers (blocklisted GPUs) start near the floor; the watchdog does the rest.
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  const software = /swiftshader|llvmpipe|software|basic render/i.test(name);
  let step = software ? 3 : options.lite ? 2 : 0;

  let time = 3.2; // start mid-cycle so the first frame already shows a lit network
  let ink = 0;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  let scroll = 0;
  let px = 1;
  const geo = { w: 1, h: 1, cx: 0, cy: 0, s: 1, bx: 0, by: 0 };

  function resize() {
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const [cap] = ladder[step] ?? [1, 0];
    px = Math.min(window.devicePixelRatio || 1, cap);
    const w = Math.max(1, Math.round(cr.width * px));
    const h = Math.max(1, Math.round(cr.height * px));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const sx = w / Math.max(1, cr.width);
    const sy = h / Math.max(1, cr.height);
    geo.w = w;
    geo.h = h;
    geo.s = sr.width * sx;
    geo.cx = (sr.left + sr.width / 2 - cr.left) * sx;
    geo.cy = (cr.bottom - (sr.top + sr.height / 2)) * sy;
    geo.bx = (sr.left + sr.width * SPHERE_X - cr.left) * sx;
    geo.by = (cr.bottom - (sr.top + sr.height * ENTRY_Y)) * sy;
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
    const halfW = s * 0.75;
    gl.useProgram(beam.program);
    gl.uniform4f(beam.u.uRect ?? null, geo.bx - halfW, 0, geo.bx + halfW, geo.by + s * 0.03);
    gl.uniform2f(beam.u.uRes ?? null, geo.w, geo.h);
    gl.uniform1f(beam.u.uPx ?? null, px);
    gl.uniform1f(beam.u.uInk ?? null, ink);
    gl.uniform1f(beam.u.uQ ?? null, q);
    gl.uniform4f(beam.u.uBeam ?? null, geo.bx, Math.max(1, geo.by), s, beamI);
    gl.uniform4f(beam.u.uSurge ?? null, surgePos, surgeVis * strength, 0, 0);
    gl.uniform4f(beam.u.uPh ?? null, (t * 0.55) % 64, (t * 2.4) % 64, 0, 0);
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

  resize();

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
    resize,
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
      resize();
      return true;
    },
    destroy() {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
