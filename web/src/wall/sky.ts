// The sky itself: atmosphere dome, clouds, stars, planets, sun and moon.
//
// World frame used by the whole wall view (kilometres, observer at the origin):
//   +X = east, +Y = up, -Z = north.
// A direction given as azimuth (from north, clockwise) and elevation becomes
//   (sin az * cos el, sin el, -cos az * cos el).

import * as THREE from "three";
import * as Astronomy from "astronomy-engine";
import { STARS } from "../display/stars.js";

const D2R = Math.PI / 180;

export function dirFromAzEl(azDeg: number, elDeg: number, out = new THREE.Vector3()) {
  const az = azDeg * D2R;
  const el = elDeg * D2R;
  const c = Math.cos(el);
  return out.set(Math.sin(az) * c, Math.sin(el), -Math.cos(az) * c);
}

/** Deterministic PRNG (mulberry32) — the faint star field must not reshuffle. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_COMMON = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uDay;      // 0 night .. 1 full day
uniform float uTwilight; // peaks while the sun is near the horizon
uniform float uMoonLit;  // moon illuminated fraction, 0 when below horizon
uniform float uStars;    // 1 when the sky is dark enough for stars
uniform mat3 uStarRot;   // equatorial -> local rotation (its transpose undoes it)
varying vec3 vDir;

// Fractal noise comes from a small tiling texture baked once at start-up: one
// lookup instead of dozens of hash evaluations per pixel, which is what lets a
// projector's modest GPU keep the sky moving smoothly.
uniform sampler2D uNoise;
float fbm(vec2 p) { return texture2D(uNoise, p / 16.0).r; }
float fbm3(vec2 p) { return texture2D(uNoise, p / 16.0 + 0.37).r; }
float noise(vec2 p) { return texture2D(uNoise, p / 16.0 + 0.71).r; }

vec3 skyColor(vec3 d) {
  float h = max(d.y, 0.0);
  vec3 dayZen = vec3(0.09, 0.26, 0.60);
  vec3 dayHor = vec3(0.60, 0.75, 0.90);
  vec3 nightZen = vec3(0.012, 0.024, 0.066) + vec3(0.016, 0.024, 0.044) * uMoonLit;
  vec3 nightHor = vec3(0.060, 0.090, 0.165) + vec3(0.030, 0.040, 0.060) * uMoonLit;
  float g = pow(h, 0.45);
  vec3 col = mix(mix(nightHor, nightZen, g), mix(dayHor, dayZen, g), uDay);

  // Twilight arch: warm band on the sun's side, cool violet opposite.
  vec2 sxz = normalize(uSunDir.xz + vec2(1e-5));
  vec2 dxz = normalize(d.xz + vec2(1e-5));
  float toward = dot(dxz, sxz) * 0.5 + 0.5;
  float low = exp(-h * 5.5);
  vec3 warm = mix(vec3(1.0, 0.36, 0.10), vec3(1.0, 0.62, 0.30), h * 3.0);
  col += warm * low * uTwilight * (0.10 + 0.90 * pow(toward, 3.0)) * 0.85;
  col += vec3(0.30, 0.16, 0.34) * exp(-h * 9.0) * uTwilight * pow(1.0 - toward, 2.0) * 0.5;

  // Ground haze below the horizon (mostly hidden by the terrain silhouette).
  if (d.y < 0.0) col *= 0.55 + 0.45 * exp(d.y * 12.0);
  return col;
}`;

const SKY_FRAG = /* glsl */ `
${SKY_COMMON}
void main() {
  vec3 d = normalize(vDir);
  vec3 col = skyColor(d);
  float sd = dot(d, normalize(uSunDir));
  float up = smoothstep(-0.03, 0.02, uSunDir.y);
  vec3 sunCol = mix(vec3(1.0, 0.45, 0.16), vec3(1.0, 0.96, 0.88), smoothstep(0.0, 0.3, uSunDir.y));
  col += sunCol * smoothstep(0.99985, 0.99995, sd) * 6.0 * up;          // disc
  col += sunCol * pow(max(sd, 0.0), 900.0) * 1.2 * up;                 // aureole
  col += sunCol * pow(max(sd, 0.0), 12.0) * 0.22 * max(uDay, uTwilight); // wide glow
  float md = dot(d, normalize(uMoonDir));
  col += vec3(0.55, 0.62, 0.80) * pow(max(md, 0.0), 220.0) * 0.24 * uMoonLit;
  col += vec3(0.30, 0.36, 0.52) * pow(max(md, 0.0), 22.0) * 0.10 * uMoonLit;

  // The Milky Way: a band along the galactic equator, brighter toward the
  // centre, mottled, with a dark dust lane down its spine.
  if (uStars > 0.02 && d.y > -0.02) {
    vec3 eq = d * uStarRot;
    const vec3 GP = vec3(-0.8676, -0.1981, 0.4560);
    const vec3 GC = vec3(-0.0550, -0.8734, -0.4839);
    vec3 gy = cross(GP, GC);
    float sb = dot(eq, GP);
    vec2 gxy = vec2(dot(eq, GC), dot(eq, gy));
    float band = exp(-(sb * sb) / 0.030);
    float core = 0.34 + 0.66 * pow(gxy.x * 0.5 + 0.5, 2.0);
    float n = fbm3(gxy * 5.0 + vec2(sb * 9.0));
    float dust = smoothstep(0.38, 0.70, fbm3(gxy * 9.0 + 3.0)) * exp(-(sb * sb) / 0.0035);
    float mw = band * core * (0.30 + 1.5 * n * n * 2.0) * (1.0 - 0.85 * dust);
    // Warm toward the galactic centre, cool blue out along the arms.
    vec3 mwCol = mix(vec3(0.20, 0.25, 0.40), vec3(0.42, 0.34, 0.27), pow(gxy.x * 0.5 + 0.5, 1.5));
    col += mwCol * mw * smoothstep(-0.02, 0.25, d.y) * uStars * (1.0 - 0.35 * uMoonLit);
    // Faint green airglow banding, as long exposures show.
    col += vec3(0.010, 0.030, 0.018) * uStars * smoothstep(0.05, 0.5, d.y) * noise(vec2(d.x * 2.0, d.y * 9.0 + d.z * 2.0));
  }
  // Warm sky-glow of hill towns hugging the horizon at night.
  col += vec3(0.20, 0.115, 0.045) * exp(-max(d.y, 0.0) * 9.0) * (1.0 - uDay) * (0.5 + 0.9 * noise(d.xz * 3.0 + 4.0));
  gl_FragColor = vec4(col, 1.0);
}`;

const CLOUD_FRAG = /* glsl */ `
${SKY_COMMON}
uniform float uCover; // 0..1 real cloud cover
uniform vec2 uDrift;  // accumulated wind offset
void main() {
  vec3 d = normalize(vDir);
  if (d.y < 0.015 || uCover < 0.02) discard;
  // Flat deck seen from below: far cloud crowds toward the horizon, as it does.
  vec2 uv = d.xz / (d.y + 0.10) * 0.55 + uDrift;
  float n = fbm(uv) * 0.75 + fbm(uv * 2.7 + 9.0) * 0.25;
  float edge = 0.78 - uCover * 0.62;
  float c = smoothstep(edge, edge + 0.22, n);
  float body = smoothstep(edge, edge + 0.55, n); // thicker cores read darker underneath
  vec3 sky = skyColor(d);
  vec3 lit = mix(vec3(0.045, 0.05, 0.065) + vec3(0.07) * uMoonLit, vec3(0.98, 0.98, 1.0), uDay);
  vec3 shade = mix(vec3(0.02, 0.024, 0.034), vec3(0.50, 0.55, 0.64), uDay);
  vec3 col = mix(lit, shade, body * 0.8);
  vec2 sxz = normalize(uSunDir.xz + vec2(1e-5));
  float toward = dot(normalize(d.xz + vec2(1e-5)), sxz) * 0.5 + 0.5;
  col += vec3(1.0, 0.42, 0.18) * uTwilight * pow(toward, 2.0) * (1.0 - body) * 0.7;
  float cmd = max(dot(d, normalize(uMoonDir)), 0.0);
  col += vec3(0.30, 0.34, 0.44) * pow(cmd, 6.0) * uMoonLit * (1.0 - uDay) * (1.0 - body * 0.7); // silver lining
  col = mix(col, sky, exp(-d.y * 7.0) * 0.8); // aerial perspective
  float a = c * smoothstep(0.015, 0.14, d.y) * 0.9;
  gl_FragColor = vec4(col, a);
}`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aBright;
attribute float aTint;
varying float vTint;
uniform float uScale;
uniform float uTime;
varying float vAlpha;
void main() {
  vTint = aTint;
  vec4 w = modelMatrix * vec4(position, 1.0);
  float alt = normalize(w.xyz).y;
  // Extinction + stronger scintillation near the horizon.
  float ext = smoothstep(-0.01, 0.22, alt);
  float tw = 1.0 - (0.10 + 0.35 * (1.0 - ext)) * (0.5 + 0.5 * sin(uTime * (2.0 + aPhase * 4.0) + aPhase * 40.0));
  vAlpha = (0.25 + 0.75 * ext) * tw * step(-0.01, alt) * aBright;
  gl_PointSize = aSize * uScale;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const STAR_FRAG = /* glsl */ `
uniform float uFade;
varying float vAlpha;
varying float vTint;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  vec3 tint = vTint < 0.0 ? mix(vec3(0.95, 0.97, 1.0), vec3(0.66, 0.78, 1.0), -vTint) : mix(vec3(0.95, 0.97, 1.0), vec3(1.0, 0.72, 0.46), vTint);
  gl_FragColor = vec4(tint, (a * a * 0.55 + smoothstep(0.45, 0.0, r) * 0.9) * vAlpha * uFade);
}`;

export interface SkyState {
  date: Date;
  sunAz: number;
  sunAlt: number;
  moonAz: number;
  moonAlt: number;
  moonIllum: number;
  /** 0 night .. 1 day. */
  day: number;
  twilight: number;
  /** Named points worth a label: planets and the brightest stars. */
  named: { name: string; az: number; alt: number; kind: "planet" | "star" }[];
}

const PLANETS: [Astronomy.Body, string, number][] = [
  [Astronomy.Body.Venus, "Venus", 1.0],
  [Astronomy.Body.Jupiter, "Jupiter", 0.85],
  [Astronomy.Body.Mars, "Mars", 0.6],
  [Astronomy.Body.Saturn, "Saturn", 0.6],
  [Astronomy.Body.Mercury, "Mercury", 0.45],
];

/** 256 px tiling fractal noise (4 octaves of periodic value noise). */
function noiseTexture(): THREE.DataTexture {
  const N = 256;
  const r = rng(4242);
  const out = new Float32Array(N * N);
  let amp = 0.5;
  for (let cells = 16; cells <= 128; cells *= 2) {
    const lat = new Float32Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = r();
    const step = N / cells;
    for (let y = 0; y < N; y++) {
      const fy = y / step;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < N; x++) {
        const fx = x / step;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const [xa, xb, ya, yb] = [x0 % cells, (x0 + 1) % cells, (y0 % cells) * cells, ((y0 + 1) % cells) * cells];
        out[y * N + x] += amp * ((lat[ya + xa] * (1 - sx) + lat[ya + xb] * sx) * (1 - sy) + (lat[yb + xa] * (1 - sx) + lat[yb + xb] * sx) * sy);
      }
    }
    amp *= 0.5;
  }
  // Stretch to the full range so cloud and Milky Way thresholds have contrast to bite on.
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < N * N; i++) {
    lo = Math.min(lo, out[i]);
    hi = Math.max(hi, out[i]);
  }
  const px = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = Math.round(((out[i] - lo) / (hi - lo)) * 255);
    px[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function glowTexture(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.25, outer);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Sky {
  readonly uniforms = {
    uSunDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uDay: { value: 0 },
    uTwilight: { value: 0 },
    uMoonLit: { value: 0 },
    uCover: { value: 0 },
    uDrift: { value: new THREE.Vector2() },
    uStars: { value: 0 },
    uStarRot: { value: new THREE.Matrix3() },
    uNoise: { value: noiseTexture() as THREE.Texture },
  };
  private starUniforms = { uScale: { value: 1 }, uTime: { value: 0 }, uFade: { value: 1 } };
  private stars: THREE.Points;
  private clouds: THREE.Mesh;
  private moon: THREE.Sprite;
  private moonCanvas = document.createElement("canvas");
  private moonTex: THREE.CanvasTexture;
  private moonDrawn = -1;
  private planets: THREE.Sprite[] = [];
  private wind = new THREE.Vector2(0.004, 0.001);
  state: SkyState = {
    date: new Date(), sunAz: 0, sunAlt: -90, moonAz: 0, moonAlt: -90, moonIllum: 0,
    day: 0, twilight: 0, named: [],
  };
  private lastAstro = -1e9;

  constructor(scene: THREE.Scene) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms, vertexShader: DOME_VERT, fragmentShader: SKY_FRAG,
        side: THREE.BackSide, depthTest: false, depthWrite: false, transparent: true,
      }),
    );
    dome.renderOrder = 0;
    dome.frustumCulled = false;
    scene.add(dome);

    this.stars = this.buildStars();
    this.stars.renderOrder = 1;
    scene.add(this.stars);

    const planetTex = glowTexture("rgba(255,250,235,1)", "rgba(255,235,200,0.35)");
    for (let i = 0; i < PLANETS.length; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: planetTex, transparent: true, depthTest: false, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      s.renderOrder = 1;
      this.planets.push(s);
      scene.add(s);
    }

    this.moonCanvas.width = this.moonCanvas.height = 128;
    this.moonTex = new THREE.CanvasTexture(this.moonCanvas);
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.moonTex, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.moon.renderOrder = 1.5;
    scene.add(this.moon);

    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(950, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms, vertexShader: DOME_VERT, fragmentShader: CLOUD_FRAG,
        side: THREE.BackSide, depthTest: false, depthWrite: false, transparent: true,
      }),
    );
    this.clouds.renderOrder = 2;
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);
  }

  /** Bright catalog stars + a seeded faint field thickened along the Milky Way. */
  private buildStars(): THREE.Points {
    const pos: number[] = [];
    const size: number[] = [];
    const phase: number[] = [];
    const bright: number[] = [];
    const tint: number[] = [];
    const R = 900;
    const push = (raDeg: number, decDeg: number, mag: number, ph: number, tn: number) => {
      const ra = raDeg * D2R;
      const dec = decDeg * D2R;
      pos.push(R * Math.cos(dec) * Math.cos(ra), R * Math.cos(dec) * Math.sin(ra), R * Math.sin(dec));
      size.push(Math.max(2.6, 14.5 - 2.2 * mag));
      bright.push(Math.max(0.5, Math.min(1, 1.35 - 0.13 * mag)));
      tint.push(tn);
      phase.push(ph);
    };
    const r = rng(20261118);
    const WARM = /Betelgeuse|Aldebaran|Antares|Arcturus|Pollux|Capella/;
    const COOL = /Rigel|Spica|Vega|Sirius|Achernar|Regulus|Bellatrix/;
    for (const s of STARS) push(s.ra, s.dec, s.mag, r(), WARM.test(s.name) ? 0.9 : COOL.test(s.name) ? -0.8 : r() * 0.6 - 0.3);
    // Galactic north pole (J2000) — faint stars cluster toward its equator.
    const gp = [Math.cos(27.13 * D2R) * Math.cos(192.86 * D2R), Math.cos(27.13 * D2R) * Math.sin(192.86 * D2R), Math.sin(27.13 * D2R)];
    let n = 0;
    while (n < 7000) {
      const z = r() * 2 - 1;
      const ra = r() * 360;
      const c = Math.sqrt(1 - z * z);
      const b = Math.asin(c * Math.cos(ra * D2R) * gp[0] + c * Math.sin(ra * D2R) * gp[1] + z * gp[2]) / D2R;
      if (r() > 0.22 + 0.78 * Math.exp(-((b / 16) ** 2))) continue;
      // Star counts roughly triple per magnitude: skew the draw toward faint.
      push(ra, Math.asin(z) / D2R, 2.8 + 3.4 * Math.pow(r(), 0.38), r(), Math.pow(r(), 2) * (r() < 0.5 ? -1 : 1));
      n++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(size, 1));
    g.setAttribute("aPhase", new THREE.Float32BufferAttribute(phase, 1));
    g.setAttribute("aBright", new THREE.Float32BufferAttribute(bright, 1));
    g.setAttribute("aTint", new THREE.Float32BufferAttribute(tint, 1));
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.starUniforms, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    pts.frustumCulled = false;
    pts.matrixAutoUpdate = false;
    return pts;
  }

  setWeather(coverPct: number, windKmh: number, windFromDeg: number): void {
    this.uniforms.uCover.value = Math.max(0, Math.min(1, coverPct / 100));
    // Clouds travel downwind; scale keeps motion gentle but perceptible.
    const to = (windFromDeg + 180) * D2R;
    const v = 0.0012 + Math.min(windKmh, 60) * 0.00025;
    this.wind.set(-Math.sin(to) * v, Math.cos(to) * v);
  }

  /** Right ascension / declination (degrees) -> a unit direction in the scene. */
  eqToWorld(raDeg: number, decDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
    const ra = raDeg * D2R;
    const dec = decDeg * D2R;
    return out.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)).applyMatrix4(this.stars.matrix);
  }

  setCloudsVisible(on: boolean): void {
    this.clouds.visible = on;
  }

  update(date: Date, lat: number, lon: number, dt: number, tSec: number, pixelScale: number, camera: THREE.Camera): void {
    const u = this.uniforms;
    u.uDrift.value.addScaledVector(this.wind, dt);
    this.starUniforms.uTime.value = tSec;
    this.starUniforms.uScale.value = pixelScale;

    // Astronomy changes slowly: recompute twice a second.
    if (Math.abs(date.getTime() - this.lastAstro) < 500) return;
    this.lastAstro = date.getTime();
    const obs = new Astronomy.Observer(lat, lon, 1200);
    const altaz = (body: Astronomy.Body) => {
      const eq = Astronomy.Equator(body, date, obs, true, true);
      const h = Astronomy.Horizon(date, obs, eq.ra, eq.dec, "normal");
      return { az: h.azimuth, alt: h.altitude };
    };
    const sun = altaz(Astronomy.Body.Sun);
    const moon = altaz(Astronomy.Body.Moon);
    const illum = Astronomy.Illumination(Astronomy.Body.Moon, date).phase_fraction;
    const smooth = (a: number, b: number, x: number) => {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const day = smooth(-7, 5, sun.alt);
    const twilight = Math.exp(-(((sun.alt + 2.5) / 6.5) ** 2));
    dirFromAzEl(sun.az, sun.alt, u.uSunDir.value);
    dirFromAzEl(moon.az, moon.alt, u.uMoonDir.value);
    u.uDay.value = day;
    u.uTwilight.value = twilight;
    u.uMoonLit.value = moon.alt > 0 ? illum * smooth(0, 12, moon.alt) : 0;
    this.starUniforms.uFade.value = 1 - smooth(-12, -3, sun.alt);

    // Equatorial -> local horizontal, as one rotation of the whole star field.
    const th = (Astronomy.SiderealTime(date) * 15 + lon) * D2R;
    const ph = lat * D2R;
    const [st, ct, sp, cp] = [Math.sin(th), Math.cos(th), Math.sin(ph), Math.cos(ph)];
    this.stars.matrix.set(
      -st, ct, 0, 0,
      cp * ct, cp * st, sp, 0,
      sp * ct, sp * st, -cp, 0,
      0, 0, 0, 1,
    );
    this.stars.matrixWorldNeedsUpdate = true;
    u.uStarRot.value.setFromMatrix4(this.stars.matrix);
    u.uStars.value = this.starUniforms.uFade.value;

    const named: SkyState["named"] = [];
    PLANETS.forEach(([body, name, bright], i) => {
      const p = altaz(body);
      const s = this.planets[i];
      s.visible = p.alt > 0.5 && sun.alt < -2;
      if (!s.visible) return;
      dirFromAzEl(p.az, p.alt, s.position).multiplyScalar(890);
      s.scale.setScalar(890 * 0.011 * (0.6 + bright));
      (s.material as THREE.SpriteMaterial).opacity = this.starUniforms.uFade.value * smooth(0.5, 8, p.alt);
      named.push({ name, az: p.az, alt: p.alt, kind: "planet" });
    });
    if (sun.alt < -8) {
      const lstH = Astronomy.SiderealTime(date) + lon / 15;
      for (const s of STARS) {
        if (s.mag > 0.9) continue;
        const H = (lstH * 15 - s.ra) * D2R;
        const dec = s.dec * D2R;
        const sinAlt = Math.sin(dec) * sp + Math.cos(dec) * cp * Math.cos(H);
        const alt = Math.asin(sinAlt);
        if (alt < 4 * D2R) continue;
        const az = Math.atan2(-Math.sin(H) * Math.cos(dec), (Math.sin(dec) - sinAlt * sp) / cp);
        named.push({ name: s.name, az: ((az / D2R) % 360 + 360) % 360, alt: alt / D2R, kind: "star" });
      }
    }

    // Moon: disc with its real lit fraction, bright limb turned toward the sun.
    this.moon.visible = moon.alt > -1;
    if (this.moon.visible) {
      dirFromAzEl(moon.az, moon.alt, this.moon.position).multiplyScalar(880);
      this.moon.scale.setScalar(880 * 0.026); // ~1.5 deg: 3x real, so the phase reads on a wall
      const waxing = Astronomy.MoonPhase(date) < 180;
      const key = Math.round(illum * 200) * (waxing ? 1 : -1);
      if (key !== this.moonDrawn) {
        this.moonDrawn = key;
        this.drawMoon(illum);
      }
      // Rotate the sprite so the lit limb faces the sun on screen.
      const a = this.moon.position.clone().project(camera);
      const b = this.moon.position.clone().addScaledVector(u.uSunDir.value, 60).project(camera);
      const mat = this.moon.material as THREE.SpriteMaterial;
      mat.rotation = Math.atan2(b.y - a.y, b.x - a.x);
      mat.opacity = 0.35 + 0.65 * (1 - day * 0.6);
    }

    this.state = {
      date, sunAz: sun.az, sunAlt: sun.alt, moonAz: moon.az, moonAlt: moon.alt,
      moonIllum: illum, day, twilight, named,
    };
  }

  /** Lit limb is drawn toward +X; the sprite rotation aims it at the sun. */
  private drawMoon(illum: number): void {
    const g = this.moonCanvas.getContext("2d")!;
    const R = 46;
    g.clearRect(0, 0, 128, 128);
    g.save();
    g.translate(64, 64);
    const halo = g.createRadialGradient(0, 0, R * 0.9, 0, 0, 64);
    halo.addColorStop(0, `rgba(200,215,255,${0.25 * illum})`);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = halo;
    g.fillRect(-64, -64, 128, 128);
    g.fillStyle = "rgba(38,42,54,0.9)"; // earthshine side
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.fill();
    // Lit region: right half-disc, plus/minus the terminator ellipse.
    const k = 1 - 2 * illum; // +1 new .. -1 full
    g.fillStyle = "#f4f1e6";
    g.beginPath();
    g.arc(0, 0, R, -Math.PI / 2, Math.PI / 2);
    g.ellipse(0, 0, Math.abs(k) * R, R, 0, Math.PI / 2, -Math.PI / 2, k > 0);
    g.fill();
    g.fillStyle = "rgba(120,120,125,0.16)"; // a hint of maria
    for (const [x, y, r] of [[8, -14, 13], [-10, 6, 10], [16, 16, 8], [-2, -26, 7]]) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    this.moonTex.needsUpdate = true;
  }
}
