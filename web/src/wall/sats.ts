// Satellites at their true positions (no distance trick — they really are up
// there). A satellite is only visible to the eye when it is in sunlight while
// the ground below is dark, so each one is tested against Earth's shadow:
// sunlit ones shine with a short motion streak, the rest are faint "ghosts".

import * as THREE from "three";
import * as Astronomy from "astronomy-engine";
import * as satellite from "satellite.js";
import { dirFromAzEl } from "./sky.js";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const RADIUS = 850;
const EARTH_KM = 6371;

export interface Tle {
  name: string;
  line1: string;
  line2: string;
}

interface Sat {
  name: string;
  rec: satellite.SatRec;
  iss: boolean;
  az: number; el: number;
  /** Degrees per second, from two propagations a second apart. */
  dAz: number; dEl: number;
  rangeKm: number;
  heightKm: number;
  sunlit: boolean;
  at: number;
}

export interface SatView {
  name: string;
  pos: THREE.Vector3;
  el: number;
  rangeKm: number;
  heightKm: number;
  /** Lit by the sun and seen against a dark sky. */
  shining: boolean;
  iss: boolean;
}

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_PointSize = aSize * uScale;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float core = smoothstep(0.45, 0.0, r);
  float glow = smoothstep(1.0, 0.0, r);
  gl_FragColor = vec4(vec3(1.0, 0.97, 0.90), (core + glow * glow * 0.6) * vAlpha);
}`;

export class Satellites {
  private sats: Sat[] = [];
  private points: THREE.Points;
  private streaks: THREE.LineSegments;
  private uniforms = { uScale: { value: 1 } };
  private lastCalc = -1e9;
  views: SatView[] = [];
  /** How many are above the horizon / of those, shining. */
  counts = { up: 0, shining: 0 };

  constructor(scene: THREE.Scene, private max = 400) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(max), 1));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(max), 1));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 6), 3));
    lg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(max * 6), 3));
    this.streaks = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 3.5;
    scene.add(this.streaks, this.points);
  }

  setTles(tles: Tle[]): void {
    this.sats = [];
    for (const t of tles.slice(0, this.max)) {
      try {
        const rec = satellite.twoline2satrec(t.line1, t.line2);
        this.sats.push({
          name: t.name.replace(/\s*\(.*\)\s*$/, "").trim(), rec,
          iss: /^ISS\b|ZARYA/i.test(t.name),
          az: 0, el: -90, dAz: 0, dEl: 0, rangeKm: 0, heightKm: 0, sunlit: false, at: 0,
        });
      } catch {
        /* skip a malformed element set */
      }
    }
    this.lastCalc = -1e9;
  }

  private look(rec: satellite.SatRec, date: Date, obs: satellite.GeodeticLocation) {
    const pv = satellite.propagate(rec, date);
    const pos = pv?.position;
    if (!pos || typeof pos === "boolean") return null;
    const ecf = satellite.eciToEcf(pos, satellite.gstime(date));
    const la = satellite.ecfToLookAngles(obs, ecf);
    return { az: la.azimuth * R2D, el: la.elevation * R2D, range: la.rangeSat, eci: pos };
  }

  update(date: Date, lat: number, lon: number, o: { sunAlt: number; ghosts: boolean; pixelScale: number; observerKm: number }): void {
    this.uniforms.uScale.value = o.pixelScale;
    const ms = date.getTime();
    if (Math.abs(ms - this.lastCalc) >= 1000) {
      this.lastCalc = ms;
      const obs = { longitude: lon * D2R, latitude: lat * D2R, height: o.observerKm };
      const sv = Astronomy.GeoVector(Astronomy.Body.Sun, date, false);
      const sl = Math.hypot(sv.x, sv.y, sv.z);
      const sun = [sv.x / sl, sv.y / sl, sv.z / sl];
      const next = new Date(ms + 1000);
      for (const s of this.sats) {
        const a = this.look(s.rec, date, obs);
        if (!a) {
          s.el = -90;
          continue;
        }
        s.az = a.az;
        s.el = a.el;
        s.rangeKm = a.range;
        s.at = ms;
        s.heightKm = Math.hypot(a.eci.x, a.eci.y, a.eci.z) - EARTH_KM;
        if (a.el < -3) continue;
        const b = this.look(s.rec, next, obs);
        s.dAz = b ? ((b.az - a.az + 540) % 360) - 180 : 0;
        s.dEl = b ? b.el - a.el : 0;
        // In Earth's shadow if behind the terminator plane and inside the cylinder.
        const along = a.eci.x * sun[0] + a.eci.y * sun[1] + a.eci.z * sun[2];
        const off = Math.hypot(a.eci.x - along * sun[0], a.eci.y - along * sun[1], a.eci.z - along * sun[2]);
        s.sunlit = along > 0 || off > EARTH_KM;
      }
    }

    const pos = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const size = this.points.geometry.getAttribute("aSize") as THREE.BufferAttribute;
    const alpha = this.points.geometry.getAttribute("aAlpha") as THREE.BufferAttribute;
    const lp = this.streaks.geometry.getAttribute("position") as THREE.BufferAttribute;
    const lc = this.streaks.geometry.getAttribute("color") as THREE.BufferAttribute;
    const dark = o.sunAlt < -5;
    const v = new THREE.Vector3();
    const w = new THREE.Vector3();
    this.views.length = 0;
    let n = 0;
    let shiningN = 0;
    for (const s of this.sats) {
      if (s.el < -1) continue;
      const f = (ms - s.at) / 1000;
      const az = s.az + s.dAz * f;
      const el = s.el + s.dEl * f;
      if (el < 0.3) continue;
      const shining = s.sunlit && dark;
      if (shining) shiningN++;
      if (!shining && !o.ghosts && !s.iss) {
        continue;
      }
      dirFromAzEl(az, el, v).multiplyScalar(RADIUS);
      // Brightness falls with range; the ISS is by far the brightest.
      const near = Math.max(0.35, Math.min(1.4, 900 / Math.max(s.rangeKm, 300)));
      const horizonFade = Math.min(1, el / 8);
      pos.setXYZ(n, v.x, v.y, v.z);
      size.setX(n, shining ? (s.iss ? 15 : 5 + 4.5 * near) : s.iss ? 8 : 3.2);
      alpha.setX(n, (shining ? 0.75 + 0.25 * near : s.iss ? 0.5 : 0.2) * horizonFade);
      // Streak: where it was 12 s (shining) or 5 s (ghost) ago.
      const back = shining ? 12 : 5;
      dirFromAzEl(az - s.dAz * back, el - s.dEl * back, w).multiplyScalar(RADIUS);
      lp.setXYZ(n * 2, v.x, v.y, v.z);
      lp.setXYZ(n * 2 + 1, w.x, w.y, w.z);
      const c = (shining ? 0.6 : 0.12) * horizonFade;
      lc.setXYZ(n * 2, c, c * 0.97, c * 0.9);
      lc.setXYZ(n * 2 + 1, 0, 0, 0);
      this.views.push({ name: s.name, pos: v.clone(), el, rangeKm: s.rangeKm, heightKm: s.heightKm, shining, iss: s.iss });
      n++;
    }
    this.points.geometry.setDrawRange(0, n);
    this.streaks.geometry.setDrawRange(0, n * 2);
    pos.needsUpdate = size.needsUpdate = alpha.needsUpdate = lp.needsUpdate = lc.needsUpdate = true;
    this.counts = { up: this.sats.filter((s) => s.el > 0.3).length, shining: shiningN };
  }
}
