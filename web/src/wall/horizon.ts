// The real skyline. Elevation tiles (Terrarium) around the observer are sampled
// along 1440 bearings; for each bearing we keep the highest elevation angle in
// three distance bands. Each band becomes a silhouette strip, drawn back to front
// with more haze the further it is — the layered-ridge look of real mountains.

import * as THREE from "three";

const D2R = Math.PI / 180;
const Z = 10;
const HALF = 3; // (2*HALF+1)^2 tiles, about +/-120 km at this latitude
const N_AZ = 1440;
const EARTH_KM = 6371;
const BANDS = [
  { max: 7, radius: 800, color: [0.030, 0.045, 0.040], haze: 0.04 },
  { max: 40, radius: 810, color: [0.085, 0.120, 0.150], haze: 0.34 },
  { max: 118, radius: 820, color: [0.230, 0.290, 0.370], haze: 0.58 },
];

const VERT = /* glsl */ `
attribute float aV;
attribute float aSnow;
varying float vV;
varying float vSnow;
void main() {
  vV = aV;
  vSnow = aSnow;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uHaze;
uniform float uDay;
uniform float uTwilight;
uniform float uMoonLit;
varying float vV;
varying float vSnow;
void main() {
  float light = 0.05 + 0.10 * uMoonLit + 0.95 * uDay;
  vec3 hazeCol = mix(vec3(0.020, 0.028, 0.050), vec3(0.60, 0.75, 0.90), uDay)
               + vec3(0.55, 0.24, 0.10) * uTwilight * 0.5;
  vec3 col = uColor * light;
  // Snow only near the crest of high ridges; alpenglow at twilight.
  vec3 snow = vec3(0.92, 0.95, 1.0) * light + vec3(0.85, 0.36, 0.22) * uTwilight * 0.75;
  col = mix(col, snow, vSnow * smoothstep(0.35, 0.95, vV));
  col = mix(col, hazeCol, uHaze * (1.0 - 0.35 * vSnow));
  gl_FragColor = vec4(col, 1.0);
}`;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, bad) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => bad(new Error(`tile ${url}`));
    im.src = url;
  });
}

export interface HorizonInfo {
  /** Ground height at the observer, metres. */
  observerM: number;
  /** Highest skyline point: bearing, elevation angle, summit height. */
  peak: { az: number; el: number; heightM: number };
}

export class Horizon {
  readonly uniforms = { uDay: { value: 0 }, uTwilight: { value: 0 }, uMoonLit: { value: 0 } };
  info: HorizonInfo | null = null;
  private skyline: Float32Array | null = null;

  /** Elevation of the terrain skyline at a bearing, degrees (0 before load). */
  skylineAt(azDeg: number): number {
    if (!this.skyline) return 0;
    return this.skyline[Math.round((((azDeg % 360) + 360) % 360) / 360 * N_AZ) % N_AZ];
  }

  constructor(private scene: THREE.Scene) {
    // Until the tiles arrive, a flat horizon keeps the ground from being sky.
    this.scene.add(this.strip(new Float32Array(N_AZ), new Float32Array(N_AZ), 0));
  }

  private placeholder(): THREE.Object3D | undefined {
    return this.scene.children.find((c) => c.name === "horizon-0-flat");
  }

  private strip(el: Float32Array, snow: Float32Array, band: number, flat = true): THREE.Mesh {
    const b = BANDS[band];
    const pos = new Float32Array((N_AZ + 1) * 2 * 3);
    const v = new Float32Array((N_AZ + 1) * 2);
    const sn = new Float32Array((N_AZ + 1) * 2);
    const idx: number[] = [];
    for (let i = 0; i <= N_AZ; i++) {
      const k = i % N_AZ;
      const az = (k / N_AZ) * 2 * Math.PI;
      for (let t = 0; t < 2; t++) {
        const e = (t === 0 ? -14 : el[k]) * D2R;
        const o = (i * 2 + t) * 3;
        pos[o] = b.radius * Math.sin(az) * Math.cos(e);
        pos[o + 1] = b.radius * Math.sin(e);
        pos[o + 2] = -b.radius * Math.cos(az) * Math.cos(e);
        v[i * 2 + t] = t;
        sn[i * 2 + t] = snow[k];
      }
      if (i < N_AZ) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aV", new THREE.BufferAttribute(v, 1));
    g.setAttribute("aSnow", new THREE.BufferAttribute(sn, 1));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms,
        uColor: { value: new THREE.Vector3(...b.color) },
        uHaze: { value: b.haze },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
    }));
    // Far band first, near band last; all after aircraft so ridges hide them.
    m.renderOrder = 20 - band;
    m.frustumCulled = false;
    m.name = `horizon-${band}${flat ? "-flat" : ""}`;
    return m;
  }

  /** Load a square mosaic of tiles and return a bilinear height sampler. */
  private async mosaic(lat: number, lon: number, z: number, half: number) {
    const n = 2 ** z;
    const mercY = (la: number) => ((1 - Math.asinh(Math.tan(la * D2R)) / Math.PI) / 2) * n;
    const cx = Math.floor(((lon + 180) / 360) * n);
    const cy = Math.floor(mercY(lat));
    const side = (2 * half + 1) * 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const jobs: Promise<void>[] = [];
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        jobs.push(
          loadImage(`/api/terrain/${z}/${cx + dx}/${cy + dy}`).then((im) => {
            ctx.drawImage(im, (dx + half) * 256, (dy + half) * 256);
          }),
        );
      }
    }
    await Promise.all(jobs);
    const px = ctx.getImageData(0, 0, side, side).data;
    const x0 = (cx - half) * 256;
    const y0 = (cy - half) * 256;
    const at = (x: number, y: number) => {
      const o = (y * side + x) * 4;
      return px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
    };
    return (la: number, lo: number): number => {
      const fx = ((lo + 180) / 360) * n * 256 - x0 - 0.5;
      const fy = mercY(la) * 256 - y0 - 0.5;
      const x = Math.floor(fx);
      const y = Math.floor(fy);
      if (x < 0 || y < 0 || x >= side - 1 || y >= side - 1) return -1e4;
      const [u, v] = [fx - x, fy - y];
      return (at(x, y) * (1 - u) + at(x + 1, y) * u) * (1 - v) + (at(x, y + 1) * (1 - u) + at(x + 1, y + 1) * u) * v;
    };
  }

  async load(lat: number, lon: number): Promise<HorizonInfo> {
    // Coarse tiles reach the far ranges; fine tiles (about 34 m) resolve the
    // hills within a few kilometres, where coarse data turns into stair-steps.
    const [far, fine] = await Promise.all([this.mosaic(lat, lon, Z, HALF), this.mosaic(lat, lon, 12, 1)]);
    const height = (la: number, lo: number, d: number): number => {
      if (d < BANDS[0].max) {
        const h = fine(la, lo);
        if (h > -9000) return h;
      }
      return far(la, lo);
    };

    const eye = height(lat, lon, 0) + 8; // roof-ish eye height above ground
    const els = BANDS.map(() => new Float32Array(N_AZ).fill(-14));
    const snow = BANDS.map(() => new Float32Array(N_AZ));
    const peak = { az: 0, el: -90, heightM: 0 };
    const kmPerLat = 111.2;
    const kmPerLon = 111.2 * Math.cos(lat * D2R);
    for (let i = 0; i < N_AZ; i++) {
      const az = (i / N_AZ) * 2 * Math.PI;
      const [se, sn] = [Math.sin(az), Math.cos(az)];
      for (let d = 0.25; d < BANDS[2].max; d *= 1.011) {
        const h = height(lat + (sn * d) / kmPerLat, lon + (se * d) / kmPerLon, d);
        if (h < -9000) break;
        // Earth curvature, with standard refraction easing it by ~13 %.
        const drop = ((d * d) / (2 * EARTH_KM)) * 0.87 * 1000;
        const e = Math.atan2(h - eye - drop, d * 1000) / D2R;
        const band = d < BANDS[0].max ? 0 : d < BANDS[1].max ? 1 : 2;
        if (e > els[band][i]) {
          els[band][i] = e;
          const t = Math.max(0, Math.min(1, (h - 4300) / 1300));
          snow[band][i] = t * t * (3 - 2 * t);
          if (e > peak.el && band === 2) Object.assign(peak, { az: (i / N_AZ) * 360, el: e, heightM: h });
        }
      }
    }
    // Take the sampling jitter out of the near and middle ridges.
    for (const [b, win] of [[0, 5], [1, 2]] as const) {
      const src = els[b].slice();
      for (let i = 0; i < N_AZ; i++) {
        let s = 0;
        for (let j = -win; j <= win; j++) s += src[(i + j + N_AZ) % N_AZ];
        els[b][i] = s / (2 * win + 1);
      }
    }
    const old = this.placeholder();
    if (old) this.scene.remove(old);
    for (let b = 0; b < BANDS.length; b++) this.scene.add(this.strip(els[b], snow[b], b, false));
    this.skyline = new Float32Array(N_AZ);
    for (let i = 0; i < N_AZ; i++) this.skyline[i] = Math.max(els[0][i], els[1][i], els[2][i]);
    this.info = { observerM: eye, peak };
    return this.info;
  }
}
