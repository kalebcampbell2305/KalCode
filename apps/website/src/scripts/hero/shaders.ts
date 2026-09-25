/**
 * GLSL ES 1.00 (runs on WebGL 1 and 2). Two draws per frame, both premultiplied:
 *   1. BEAM: the energy stream rising from below the hero into the bottom of the sphere.
 *   2. ORB:  the KalCode symbol (base texture), lit from inside by the data layer (orb-fx):
 *            a travelling front along the art's own orbits and nodes, flowing data along the
 *            lines, bloom, the contact glow, and two thin procedural orbit rings in 3D.
 * Light is emitted with alpha 0 (pure additive over the page); on light surfaces `uInk` turns
 * off-art light into translucent blue ink so it stays visible without glowing.
 * All time-dependent values arrive as periodic phases computed on the CPU (no float drift).
 */
import { ENTRY_Y, SPHERE_R, SPHERE_X, SPHERE_Y } from "./meta";

const f = (n: number) => n.toFixed(4);

const COMMON = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float uPx;
uniform float uInk;
uniform float uQ;
float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
// Value noise, periodic in y with period 64 so scrolling phases can wrap seamlessly.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, 64.0);
  float y1 = mod(i.y + 1.0, 64.0);
  return mix(mix(hash(vec2(i.x, y0)), hash(vec2(i.x + 1.0, y0)), u.x),
             mix(hash(vec2(i.x, y1)), hash(vec2(i.x + 1.0, y1)), u.x), u.y);
}
float n1(float x) {
  float i = floor(x);
  float t = fract(x);
  t = t * t * (3.0 - 2.0 * t);
  return mix(hash(vec2(i, 7.13)), hash(vec2(i + 1.0, 7.13)), t);
}
vec4 emit(vec3 L, vec3 baseRgb, float baseA) {
  float a = clamp(max(L.r, max(L.g, L.b)), 0.0, 1.0);
  float ink = uInk * (1.0 - baseA);
  float ia = ink * clamp(pow(a, 1.35) * 0.9, 0.0, 0.88);
  vec3 inkCol = mix(vec3(0.04, 0.20, 0.72), vec3(0.11, 0.36, 0.88), a);
  return vec4(baseRgb + L * (1.0 - ink) + inkCol * ia, baseA + ia * (1.0 - baseA));
}
`;

export const BEAM_VS = `
attribute vec2 aPos;
uniform vec4 uRect;
uniform vec2 uRes;
void main() {
  vec2 p = mix(uRect.xy, uRect.zw, aPos * 0.5 + 0.5);
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const BEAM_FS = `${COMMON}
uniform vec4 uBeam;  // x, contact y, orb size s, intensity
uniform vec4 uSurge; // position along the beam (0..1), visibility, unused, unused
uniform vec4 uPh;    // fibre scroll (mod 64), mote scroll (mod 64), unused, unused
uniform vec4 uBand;  // text-safe band: top y, bottom y (canvas px, y up), level inside, level below
uniform vec4 uOrigin; // stream origin x, y (canvas px, y up), platform ring radius (0 = none), ripple 0..1
uniform vec4 uUp;     // upward continuation: start y (behind the sphere top), end y, strength (0 = off), pulse 0..1 (-1 = none)
void main() {
  vec2 fc = gl_FragCoord.xy;
  float s = uBeam.z;
  float dx = fc.x - uBeam.x;
  float adx = abs(dx);
  float yb = fc.y - uOrigin.y;
  float v = yb / max(1.0, uBeam.y - uOrigin.y);
  float up = smoothstep(0.55, 1.0, v);
  float low = pow(max(1.0 - v, 0.0), 3.0);
  // Everything fades to zero before the quad's edge (no visible rectangle).
  float win = 1.0 - smoothstep(0.55 * s, 0.74 * s, adx);

  float sp = exp(-pow((v - uSurge.x) / 0.075, 2.0)) * uSurge.y;
  float wc = uPx * (1.0 + 1.5 * up + 1.8 * low) * (1.0 + 0.5 * sp);
  float wg = s * (0.014 + 0.018 * up + 0.05 * low) * (1.0 + 0.7 * sp);

  float core = exp(-dx * dx / (wc * wc));
  float glow = exp(-adx / wg);
  float halo = exp(-adx / (wg * 5.0 + s * 0.015));

  // Fibres: vertically stretched noise drifting upward, so the glow reads as a moving stream.
  float fib = 1.0;
  if (adx < wg * 8.0) {
    vec2 q = vec2(dx / (uPx * 2.6), fc.y / s * 2.4 - uPh.x);
    fib = 0.2 + 1.25 * vnoise(q);
    if (uQ > 0.5) fib = mix(fib, 0.2 + 1.25 * vnoise(q * vec2(2.3, 1.6) + vec2(11.0, 0.0)), 0.35);
    // Filaments: fine bright strands hugging the core, drifting upward faster than the glow.
    float fil = vnoise(vec2(dx / (uPx * 1.3), fc.y / s * 1.1 - uPh.x * 1.7));
    fib += pow(fil, 5.0) * 2.2 * exp(-adx / (wg * 0.7));
  }

  float I = uBeam.w * (0.85 + 0.35 * up);

  // Text-safe band: behind the headline the sharp core almost disappears while a soft volume of
  // light stays, so the column still reads as continuous; below the band it resumes.
  float e = 20.0 * uPx;
  float below = 1.0 - smoothstep(uBand.y - e, uBand.y + e, fc.y);
  float inBand = (1.0 - below) * (1.0 - smoothstep(uBand.x - e, uBand.x + e, fc.y));
  float kCore = mix(mix(1.0, uBand.z, inBand), uBand.w, below);
  float kGlow = mix(mix(1.0, min(1.0, uBand.z * 2.6), inBand), uBand.w, below);
  float cut = 1.0 - smoothstep(0.985, 1.03, v);

  // Source haze at the bottom edge: the stream arrives from a larger system below the fold.
  float ay = max(yb, -yb * 4.0);
  float hz = exp(-pow(dx / (s * 0.26), 2.0)) * exp(-ay / (s * 0.085));
  float floorGlow = exp(-pow(dx / (s * 0.4), 2.0)) * exp(-ay / (s * 0.03));
  float rays = 0.6 + 0.8 * vnoise(vec2(atan(dx, yb + s * 0.35) * 26.0, uPh.x * 0.25));
  cut *= smoothstep(-0.012 * s, 0.0, yb);

  vec3 L = vec3(0.86, 0.93, 1.0) * core * (0.95 + 2.2 * sp) * I * kCore
         + (vec3(0.26, 0.52, 1.0) * glow * fib * 0.7 * (1.0 + 1.6 * sp) * I
         + vec3(0.09, 0.22, 0.78) * halo * 0.2 * I * (1.0 - 0.6 * uInk)) * kGlow;
  L *= cut;
  L += (vec3(0.18, 0.42, 1.0) * hz * rays * 0.42 + vec3(0.10, 0.26, 0.85) * floorGlow * 0.2) * uBeam.w;
  L *= win;

  // Data motes rising inside the stream.
  if (uQ > 0.25 && adx < wg * 3.0 && v < 1.0) {
    vec2 cell = vec2(dx / (uPx * 6.0), fc.y / (uPx * 30.0) - uPh.y);
    vec2 id = floor(cell);
    float r = hash(vec2(id.x, mod(id.y, 64.0)) + 3.7);
    if (r > 0.9) {
      vec2 c = vec2(0.5 + (hash(id.yx + 1.3) - 0.5) * 0.5, 0.5);
      vec2 o = (fract(cell) - c) * vec2(6.0, 30.0);
      float m = exp(-(o.x * o.x + o.y * o.y * 0.08) / 0.9);
      L += vec3(0.7, 0.85, 1.0) * m * 0.55 * exp(-adx / (wg * 1.2)) * I * (1.0 - up * 0.6) * kCore;
    }
  }

  // Orbital platform: a light pool where the stream leaves the ring centre, and a ripple that
  // runs out across the rings each time a surge launches. Rings are ~10:1 in perspective.
  if (uOrigin.z > 0.0) {
    vec2 dp = vec2(fc.x - uOrigin.x, yb * 10.0);
    float rn = length(dp) / uOrigin.z;
    float pool = exp(-rn * 7.0) * 0.4 + exp(-rn * 2.2) * 0.06;
    float rip = exp(-pow((rn - uOrigin.w) / 0.03, 2.0)) * (1.0 - uOrigin.w) * smoothstep(0.0, 0.08, uOrigin.w);
    L += vec3(0.28, 0.55, 1.0) * (pool + rip * 0.35) * uBeam.w * (1.0 - smoothstep(0.9, 1.1, rn));
  }
  // Upward continuation: a faint thread of the same energy leaving the top of the orb, fading
  // to nothing well below the page's navigation; each surge sends a soft echo up it.
  if (uUp.z > 0.0 && fc.y > uUp.x) {
    float tu = (fc.y - uUp.x) / max(1.0, uUp.y - uUp.x);
    float fade = pow(1.0 - clamp(tu, 0.0, 1.0), 1.5) * smoothstep(0.0, 0.08, tu);
    float wcu = uPx * (0.9 + 0.6 * tu);
    float wgu = s * (0.014 + 0.035 * tu);
    float coreU = exp(-dx * dx / (wcu * wcu));
    float glowU = exp(-adx / wgu);
    float echo = uUp.w < 0.0 ? 0.0 : exp(-pow((tu - uUp.w) / 0.09, 2.0)) * (1.0 - uUp.w);
    L += (vec3(0.8, 0.9, 1.0) * coreU * (0.4 + 1.1 * echo) + vec3(0.24, 0.5, 1.0) * glowU * fib * (0.22 + 0.5 * echo))
       * fade * uUp.z * uBeam.w;
  }
  gl_FragColor = emit(L, vec3(0.0), 0.0);
}
`;

export const ORB_VS = `
attribute vec2 aPos;
uniform vec2 uRes;
uniform vec4 uOrb;  // centre x, centre y, size s, focal length
uniform mat3 uTilt;
varying vec2 vUv;
varying vec2 vLocal;
void main() {
  vec2 local = aPos * uOrb.z * 0.66;
  vec3 p = uTilt * vec3(local, 0.0);
  float k = uOrb.w / (uOrb.w - p.z);
  vec2 screen = uOrb.xy + p.xy * k;
  gl_Position = vec4(screen / uRes * 2.0 - 1.0, 0.0, 1.0);
  vLocal = local;
  vUv = vec2(local.x / uOrb.z + 0.5, 0.5 - local.y / uOrb.z);
}
`;

export const ORB_FS = `${COMMON}
uniform sampler2D uBase;
uniform sampler2D uFx;
uniform sampler2D uBloom;
uniform vec4 uOrb;
uniform vec4 uCyc;   // front F, envelope E, arrival A, cycle seed
uniform vec4 uPh;    // twinkle phase, flow phase, flow gate drift, breath (0..1)
uniform vec3 uR1u;
uniform vec3 uR1v;
uniform vec3 uR2u;
uniform vec3 uR2v;
uniform vec4 uRing;  // comet angle 1, comet angle 2, ring strength, unused
varying vec2 vUv;
varying vec2 vLocal;

const float TAU = 6.2831853;

float ring(vec2 q, vec3 U, vec3 V, float comet, vec2 sc, float R) {
  mat2 M = mat2(U.xy, V.xy);
  float det = M[0][0] * M[1][1] - M[1][0] * M[0][1];
  if (abs(det) < 1.0) return 0.0;
  mat2 Mi = mat2(M[1][1], -M[0][1], -M[1][0], M[0][0]) / det;
  vec2 w = Mi * q;
  float th = atan(w.y, w.x);
  vec2 cs = vec2(cos(th), sin(th));
  float dist = length(q - M * cs);
  float radius = length(U);
  float z = dot(vec2(U.z, V.z), cs);
  float behind = 1.0 - smoothstep(-2.0 * uPx, 2.0 * uPx, z);
  float onSphere = 1.0 - smoothstep(R * 0.97, R * 1.01, length(q - sc));
  float occ = 1.0 - behind * onSphere;
  float depth = 0.5 + 0.5 * z / radius;
  float pw = uPx * 0.7;
  float prof = exp(-dist * dist / (pw * pw)) + 0.16 * exp(-dist / (uPx * 3.5));
  float dth = mod(comet - th, TAU);
  float head = exp(-pow(min(dth, TAU - dth) / 0.05, 2.0));
  float tail = exp(-dth * 2.2) * step(0.0, dth);
  return prof * occ * (uRing.z * (0.25 + 0.75 * depth) + head * 0.9 + tail * 0.45 * depth);
}

void main() {
  float inside = step(0.0, vUv.x) * step(vUv.x, 1.0) * step(0.0, vUv.y) * step(vUv.y, 1.0);
  vec4 base = texture2D(uBase, vUv) * inside;
  vec3 fx = texture2D(uFx, vUv).rgb * inside;
  float line = fx.r;
  float node = fx.g;
  float d = fx.b;

  float F = uCyc.x;
  float E = uCyc.y;
  float A = uCyc.z;
  float gap = F - d;
  float band = exp(-gap * gap / 0.0026);
  float trail = smoothstep(-0.02, 0.01, gap) * exp(-max(gap, 0.0) / 0.2);
  float fire = smoothstep(0.3, 0.62, n1(d * 46.0 + uCyc.w * 17.0));
  float tw = 0.5 + 0.5 * sin(TAU * (uPh.x + d * 23.0));
  float flow = pow(max(sin(TAU * (d * 64.0 - uPh.y)), 0.0), 18.0)
             * smoothstep(0.48, 0.82, n1(d * 6.0 + uPh.z));
  float lum = dot(base.rgb, vec3(0.2126, 0.7152, 0.0722));

  vec3 cLine = vec3(0.42, 0.68, 1.0);
  vec3 cHot = vec3(0.82, 0.92, 1.0);
  vec3 L = cLine * line * ((band + 0.42 * trail) * E * 1.35 + flow * 0.5 * uQ + flow * 0.25)
         + cHot * node * ((band * 1.8 + trail * 0.75 * fire) * E + 0.06 + 0.12 * tw)
         + cLine * lum * band * E * 0.3;

  L += texture2D(uBloom, vUv).rgb * inside * (0.09 + 0.16 * E + 0.2 * A + 0.04 * uPh.w);

  float s = uOrb.z;
  vec2 q = vLocal;
  float win = 1.0 - smoothstep(0.5 * s, 0.65 * s, max(abs(q.x), abs(q.y)));
  vec2 sc = vec2(${f(SPHERE_X - 0.5)} * s, ${f(0.5 - SPHERE_Y)} * s);
  float R = ${f(SPHERE_R)} * s;
  float rr = length(q - sc) / R;
  L += vec3(0.22, 0.48, 1.0) * exp(-abs(rr - 1.0) * 16.0) * (0.05 + 0.08 * E);
  L += vec3(0.12, 0.30, 0.95) * exp(-max(rr - 1.0, 0.0) * 5.0) * step(1.0, rr) * 0.05 * win;

  vec2 entry = vec2(sc.x, ${f(0.5 - ENTRY_Y)} * s);
  vec2 eo = (q - entry) / (s * vec2(0.055, 0.03));
  float ce = dot(eo, eo);
  L += vec3(0.62, 0.8, 1.0) * exp(-ce) * (0.3 + 0.9 * A) + vec3(0.2, 0.45, 1.0) * exp(-sqrt(ce) * 0.9) * (0.08 + 0.2 * A);

  vec3 cRing = vec3(0.5, 0.72, 1.0);
  L += cRing * ring(q, uR1u, uR1v, uRing.x, sc, R) * (1.0 + 0.3 * E);
  L += cRing * ring(q, uR2u, uR2v, uRing.y, sc, R) * (1.0 + 0.3 * E);

  // Light surfaces: drop the art's faint outer haze (it reads as fog on paper), keep the lines.
  base *= mix(1.0, smoothstep(0.1, 0.5, base.a), uInk * smoothstep(0.99, 1.05, rr));
  gl_FragColor = emit(L * win, base.rgb, base.a);
}
`;
