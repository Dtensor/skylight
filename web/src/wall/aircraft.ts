// Aircraft as small 3D models seen from the ground: true bearing, altitude and
// heading; ground distance divided by `compress` so far-off airway traffic rises
// off the horizon. By day they are lit airframes trailing contrails; by night
// they are what you really see — red/green/white lights and a flashing beacon.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Aircraft } from "@shared/index.js";

const D2R = Math.PI / 180;
const FT_KM = 0.0003048;
const KT_KMS = 0.000514444;
const EARTH_KM = 6371;
const TRAIL_N = 48;
const TRAIL_SEC = 600;
const CONTRAIL_FT = 26000;

type Kind = "jet" | "wide" | "prop";

const WIDE = /^(A33|A34|A35|A38|B74|B76|B77|B78|IL96|MD11|A30|A31|B75)/;
const PROP = /^(AT[4-7]|DH8|D228|D328|C208|PC12|B350|BE20|SF34|E120|L410|AN2|PC6|C17[0-9]|C18|C20|P28|DHC|Q4)/;

function kindOf(type: string | undefined, category: string | undefined): Kind {
  const t = (type ?? "").toUpperCase();
  if (WIDE.test(t)) return "wide";
  if (PROP.test(t) || category === "A1") return "prop";
  if (category === "A5") return "wide";
  return "jet";
}

/** Thin flat panel from an outline given as [x, z] pairs, lying at height y. */
function panel(pts: [number, number][], y: number, thick: number): THREE.BufferGeometry {
  const s = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z)));
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
  g.rotateX(Math.PI / 2); // outline y -> world z, extrusion -> down
  g.translate(0, y + thick / 2, 0);
  return g;
}

function mirrored(pts: [number, number][]): [number, number][] {
  return pts.map(([x, z]) => [-x, z] as [number, number]).reverse();
}

/** Unit-length airframe: nose toward -Z, up +Y, right wing toward +X. */
function buildModel(kind: Kind): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const r = kind === "wide" ? 0.062 : kind === "prop" ? 0.05 : 0.054;
  const body = new THREE.CylinderGeometry(r, r, 0.66, 14);
  body.rotateX(Math.PI / 2);
  parts.push(body);
  const nose = new THREE.SphereGeometry(r, 14, 10);
  nose.scale(1, 1, 2.4);
  nose.translate(0, 0, -0.33);
  parts.push(nose);
  const tail = new THREE.ConeGeometry(r, 0.3, 14);
  tail.rotateX(Math.PI / 2); // tip toward +Z
  tail.translate(0, r * 0.25, 0.48);
  parts.push(tail);

  const wing: [number, number][] =
    kind === "prop"
      ? [[0.03, -0.07], [0.5, -0.035], [0.5, 0.03], [0.03, 0.06]]
      : [[0.03, -0.13], [0.5, 0.1], [0.5, 0.155], [0.03, 0.08]];
  const wy = kind === "prop" ? r * 0.85 : -r * 0.45;
  parts.push(panel(wing, wy, 0.014), panel(mirrored(wing), wy, 0.014));
  const stab: [number, number][] = [[0.02, 0.4], [0.19, 0.5], [0.19, 0.54], [0.02, 0.5]];
  const sy = kind === "prop" ? 0.16 : r * 0.3;
  parts.push(panel(stab, sy, 0.01), panel(mirrored(stab), sy, 0.01));

  const fin = new THREE.ExtrudeGeometry(
    new THREE.Shape([[0.34, 0], [0.52, 0.19], [0.58, 0.19], [0.52, 0]].map(([z, y]) => new THREE.Vector2(z, y))),
    { depth: 0.012, bevelEnabled: false },
  );
  fin.rotateY(-Math.PI / 2); // outline x -> world z
  fin.translate(0.006, r * 0.5, 0);
  parts.push(fin);

  for (let i = 0; i < 2; i++) {
    const side = i % 2 ? -1 : 1;
    const ex = side * (kind === "prop" ? 0.15 : 0.17);
    const e = new THREE.CylinderGeometry(kind === "prop" ? 0.02 : 0.03, kind === "prop" ? 0.016 : 0.026, 0.13, 10);
    e.rotateX(Math.PI / 2);
    e.translate(ex, wy - (kind === "prop" ? 0.005 : 0.035), kind === "prop" ? -0.06 : -0.05);
    parts.push(e);
    if (kind === "prop") {
      const disc = new THREE.CylinderGeometry(0.075, 0.075, 0.004, 16);
      disc.rotateX(Math.PI / 2);
      disc.translate(ex, wy - 0.005, -0.13);
      parts.push(disc);
    }
  }
  const merged = mergeGeometries(parts.map((p) => {
    const q = p.index ? p.toNonIndexed() : p;
    q.deleteAttribute("uv");
    return q;
  }));
  merged.computeVertexNormals();
  return merged;
}

const TRAIL_VERT = /* glsl */ `
attribute float aAge;
attribute float aSide;
varying float vAge;
varying float vSide;
void main() {
  vAge = aAge;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const TRAIL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAge;
varying float vSide;
void main() {
  float across = 1.0 - vSide * vSide;
  float along = smoothstep(0.0, 0.03, vAge) * pow(1.0 - vAge, 1.6);
  gl_FragColor = vec4(uColor, across * along * uOpacity);
}`;

function lightTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.8)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.16)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

interface Craft {
  ac: Aircraft;
  group: THREE.Group;
  lights: { red: THREE.Sprite; green: THREE.Sprite; tail: THREE.Sprite; beacon: THREE.Sprite; strobeL: THREE.Sprite; strobeR: THREE.Sprite; landing: THREE.Sprite };
  trail: THREE.Mesh;
  /** Smoothed real position, km east/north of the observer, and altitude km. */
  e: number; n: number; alt: number;
  /** Where the latest fix says it is (advanced by velocity between fixes). */
  te: number; tn: number; talt: number;
  ve: number; vn: number; valt: number;
  heading: number;
  /** Real-space breadcrumbs for the contrail, newest first: [e, n, alt, t]. */
  crumbs: [number, number, number, number][];
  lastSeen: number;
  life: number;
  phase: number;
}

export interface CraftView {
  ac: Aircraft;
  /** Scene position (compressed), for label projection. */
  pos: THREE.Vector3;
  /** True slant range from the observer, km. */
  rangeKm: number;
  /** Apparent elevation / azimuth in the scene, degrees. */
  el: number;
  az: number;
  alpha: number;
}

export class Fleet {
  private crafts = new Map<string, Craft>();
  private geo: Record<Kind, THREE.BufferGeometry>;
  private bodyMat = new THREE.MeshStandardMaterial({ color: 0xe9edf2, roughness: 0.55, metalness: 0.25, side: THREE.DoubleSide, transparent: true });
  private lightTex = lightTexture();
  private trailUniforms = { uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0.8 } };
  private trailMat: THREE.ShaderMaterial;
  private sun = new THREE.DirectionalLight(0xffffff, 0);
  private hemi = new THREE.HemisphereLight(0xbcd4ff, 0x39434a, 0.2);
  views: CraftView[] = [];

  constructor(private scene: THREE.Scene) {
    this.geo = { jet: buildModel("jet"), wide: buildModel("wide"), prop: buildModel("prop") };
    this.trailMat = new THREE.ShaderMaterial({
      uniforms: this.trailUniforms, vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG,
      transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    scene.add(this.sun, this.sun.target, this.hemi);
  }

  private sprite(color: number): THREE.Sprite {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.lightTex, color, transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
    }));
    s.renderOrder = 8;
    return s;
  }

  private spawn(ac: Aircraft, now: number): Craft {
    const kind = kindOf(ac.typeCode, ac.category);
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(this.geo[kind], this.bodyMat);
    mesh.renderOrder = 6;
    group.add(mesh);
    const L = {
      red: this.sprite(0xff2a1e), green: this.sprite(0x24ff62), tail: this.sprite(0xffffff),
      beacon: this.sprite(0xff3020), strobeL: this.sprite(0xffffff), strobeR: this.sprite(0xffffff),
      landing: this.sprite(0xfff3d0),
    };
    L.red.position.set(-0.5, 0, 0.13);
    L.green.position.set(0.5, 0, 0.13);
    L.tail.position.set(0, 0.03, 0.62);
    L.beacon.position.set(0, -0.08, 0);
    L.strobeL.position.set(-0.5, 0, 0.14);
    L.strobeR.position.set(0.5, 0, 0.14);
    L.landing.position.set(0, -0.06, -0.3);
    group.add(...Object.values(L));
    group.userData.scaleMul = kind === "wide" ? 1.45 : kind === "prop" ? 0.8 : 1;

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
    const age = new Float32Array(TRAIL_N * 2);
    const side = new Float32Array(TRAIL_N * 2);
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_N; i++) {
      age[i * 2] = age[i * 2 + 1] = i / (TRAIL_N - 1);
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
      if (i < TRAIL_N - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    g.setAttribute("aAge", new THREE.BufferAttribute(age, 1));
    g.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    g.setIndex(idx);
    const trail = new THREE.Mesh(g, this.trailMat);
    trail.frustumCulled = false;
    trail.renderOrder = 5;
    this.scene.add(group, trail);

    let h = 0;
    for (const ch of ac.hex) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const c: Craft = {
      ac, group, lights: L, trail,
      e: 0, n: 0, alt: 0, te: 0, tn: 0, talt: 0, ve: 0, vn: 0, valt: 0,
      heading: ac.track ?? 0, crumbs: [], lastSeen: now, life: 0, phase: (h % 1000) / 1000,
    };
    return c;
  }

  /** Feed a fresh snapshot of fixes. */
  ingest(list: Aircraft[], lat: number, lon: number, maxKm: number): void {
    const now = performance.now() / 1000;
    const kmLat = 111.2;
    const kmLon = 111.2 * Math.cos(lat * D2R);
    for (const ac of list) {
      if (ac.lat == null || ac.lon == null || ac.onGround) continue;
      const altFt = ac.altGeom ?? ac.altBaro;
      if (altFt == null) continue;
      const te = (ac.lon - lon) * kmLon;
      const tn = (ac.lat - lat) * kmLat;
      if (Math.hypot(te, tn) > maxKm) continue;
      let c = this.crafts.get(ac.hex);
      const fresh = !c;
      if (!c) {
        c = this.spawn(ac, now);
        this.crafts.set(ac.hex, c);
      }
      c.ac = ac;
      c.lastSeen = now;
      const tr = (ac.track ?? c.heading) * D2R;
      const v = (ac.gs ?? 0) * KT_KMS;
      // The fix is already `seen` seconds old: carry it forward to now.
      const lag = Math.min(ac.seen ?? 0, 15);
      c.ve = Math.sin(tr) * v;
      c.vn = Math.cos(tr) * v;
      c.valt = ((ac.baroRate ?? 0) / 60) * FT_KM;
      c.te = te + c.ve * lag;
      c.tn = tn + c.vn * lag;
      c.talt = altFt * FT_KM;
      if (fresh) {
        c.e = c.te;
        c.n = c.tn;
        c.alt = c.talt;
        // Lay the contrail it has already drawn, by flying the track backward.
        for (let i = 0; i < TRAIL_N; i++) {
          const dt = (i / (TRAIL_N - 1)) * TRAIL_SEC;
          c.crumbs.push([c.e - c.ve * dt, c.n - c.vn * dt, c.alt, now - dt]);
        }
      }
    }
  }

  /** Real (e, n, alt) -> scene position. Ground distance is divided by k. */
  private place(e: number, n: number, alt: number, k: number, obsKm: number, out: THREE.Vector3): THREE.Vector3 {
    const r = Math.hypot(e, n) / k;
    return out.set(e / k, alt - obsKm - (r * r) / (2 * EARTH_KM), -n / k);
  }

  update(dt: number, tSec: number, o: { compress: number; observerKm: number; day: number; twilight: number; moonLit: number; sunDir: THREE.Vector3; staleSec: number }): void {
    const now = performance.now() / 1000;
    const k = Math.max(1, o.compress);
    const night = 1 - o.day;

    // Lighting: sun by day, a thin moonlit ambient by night.
    this.sun.position.copy(o.sunDir).multiplyScalar(100);
    this.sun.intensity = 2.6 * o.day;
    this.sun.color.setRGB(1, 0.55 + 0.45 * Math.min(1, o.sunDir.y * 4 + 0.2), 0.3 + 0.7 * Math.min(1, o.sunDir.y * 4));
    this.hemi.intensity = 0.05 + 0.05 * o.moonLit + 1.0 * o.day + 0.25 * o.twilight;
    // Contrails: white by day, catching orange at dusk, faint and grey at night.
    this.trailUniforms.uColor.value.setRGB(
      0.16 + 0.84 * o.day + 0.5 * o.twilight,
      0.18 + 0.82 * o.day + 0.16 * o.twilight,
      0.24 + 0.76 * o.day,
    );
    this.trailUniforms.uOpacity.value = 0.22 + 0.55 * o.day + 0.2 * o.twilight + 0.1 * o.moonLit;

    this.views.length = 0;
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const perp = new THREE.Vector3();
    for (const [hex, c] of this.crafts) {
      const age = now - c.lastSeen;
      c.life += ((age > o.staleSec ? 0 : 1) - c.life) * Math.min(1, dt * 1.2);
      if (age > o.staleSec + 6 && c.life < 0.02) {
        this.scene.remove(c.group, c.trail);
        c.trail.geometry.dispose();
        this.crafts.delete(hex);
        continue;
      }
      // Fly the target on, and ease the drawn position onto it (no snapping).
      c.te += c.ve * dt;
      c.tn += c.vn * dt;
      c.talt += c.valt * dt;
      const ease = 1 - Math.exp(-dt / 1.6);
      c.e += c.ve * dt + (c.te - c.e) * ease;
      c.n += c.vn * dt + (c.tn - c.n) * ease;
      c.alt += (c.talt - c.alt) * ease;
      if (c.ac.track != null) {
        const d = ((c.ac.track - c.heading + 540) % 360) - 180;
        c.heading += d * Math.min(1, dt * 0.8);
      }

      this.place(c.e, c.n, c.alt, k, o.observerKm, p);
      const dist = p.length();
      // Exaggerated but still perspective-ish: nearer aircraft are bigger.
      const angDeg = Math.max(1.5, Math.min(5.5, 3.1 * Math.sqrt(14 / Math.max(dist, 1.5)))) * (c.group.userData.scaleMul as number);
      const scale = dist * Math.tan(angDeg * D2R);
      c.group.position.copy(p);
      c.group.scale.setScalar(scale);
      const pitch = Math.max(-0.2, Math.min(0.2, Math.atan2(c.valt, Math.hypot(c.ve, c.vn) + 1e-6)));
      c.group.rotation.set(pitch, -c.heading * D2R, 0, "YXZ");
      c.group.visible = c.life > 0.01 && p.y > -0.5;

      // Lights. Steady nav lights; beacon ~1 Hz; strobes double-flash.
      const L = c.lights;
      const t = tSec + c.phase * 3;
      const beacon = (t % 1.1) < 0.09 ? 1 : 0;
      const st = t % 1.25;
      const strobe = st < 0.05 || (st > 0.14 && st < 0.19) ? 1 : 0;
      const navA = (0.25 + 0.75 * night) * c.life;
      const s0 = 0.10 + 0.10 * night;
      for (const [sp, a, sz] of [
        [L.red, navA, s0], [L.green, navA, s0], [L.tail, navA * 0.8, s0 * 0.8],
        [L.beacon, beacon * c.life, s0 * 1.6], [L.strobeL, strobe * c.life, s0 * 2.2], [L.strobeR, strobe * c.life, s0 * 2.2],
        [L.landing, (c.alt - o.observerKm < 3 ? 1 : 0) * c.life, s0 * 2.6],
      ] as [THREE.Sprite, number, number][]) {
        sp.material.opacity = a;
        sp.scale.setScalar(sz);
      }

      // Contrail breadcrumbs: drop one every TRAIL_SEC / TRAIL_N seconds.
      const step = TRAIL_SEC / (TRAIL_N - 1);
      if (now - c.crumbs[1][3] >= step) {
        c.crumbs.unshift([c.e, c.n, c.alt, now]);
        c.crumbs.length = TRAIL_N;
      }
      c.crumbs[0] = [c.e, c.n, c.alt, now];
      const altFt = c.alt / FT_KM;
      c.trail.visible = c.group.visible && altFt > CONTRAIL_FT;
      if (c.trail.visible) {
        const pos = c.trail.geometry.getAttribute("position") as THREE.BufferAttribute;
        const arr = pos.array as Float32Array;
        for (let i = 0; i < TRAIL_N; i++) {
          const cr = c.crumbs[i];
          this.place(cr[0], cr[1], cr[2], k, o.observerKm, q);
          const nx = c.crumbs[Math.min(i + 1, TRAIL_N - 1)];
          const pv = c.crumbs[Math.max(i - 1, 0)];
          this.place(pv[0] - nx[0], pv[1] - nx[1], 0, k, 0, tan);
          tan.y = 0;
          // Ribbon faces the observer (who sits at the origin).
          perp.crossVectors(q, tan).normalize();
          const a = i / (TRAIL_N - 1);
          const w = scale * (0.035 + 0.22 * Math.sqrt(a));
          arr.set([q.x - perp.x * w, q.y - perp.y * w, q.z - perp.z * w, q.x + perp.x * w, q.y + perp.y * w, q.z + perp.z * w], i * 6);
        }
        pos.needsUpdate = true;
      }

      if (c.group.visible) {
        this.views.push({
          ac: c.ac, pos: p.clone(),
          rangeKm: Math.hypot(c.e, c.n, c.alt - o.observerKm),
          el: Math.asin(Math.max(-1, Math.min(1, p.y / dist))) / D2R,
          az: (Math.atan2(p.x, -p.z) / D2R + 360) % 360,
          alpha: c.life,
        });
      }
    }
    this.bodyMat.emissive.setScalar(0); // airframes are lit only by sky, sun and moon
  }
}
