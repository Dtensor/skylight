// Foreground: a ring of tall hill conifers a few tens of metres away. On a flat
// wall there is no parallax, so the eye judges depth by what passes in front of
// what — aircraft, contrails and stars slipping behind near branches is what
// makes the sky read as far away rather than painted on the wall.

import * as THREE from "three";

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

/** A white-on-transparent conifer silhouette; tinted by the material colour. */
function treeTexture(seed: number): THREE.CanvasTexture {
  const r = rng(seed);
  const W = 256;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(W / 2 - 3, H * 0.12, 6, H * 0.88); // trunk
  const tiers = 34 + Math.floor(r() * 10);
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = H * (0.03 + 0.80 * t);
    const half = (8 + (W * 0.44 - 8) * Math.pow(t, 0.8)) * (0.72 + 0.4 * r());
    const droop = 8 + 16 * t;
    for (const side of [-1, 1]) {
      const reach = half * (0.75 + 0.35 * r());
      g.beginPath();
      g.moveTo(W / 2, y - 6);
      // Ragged lower edge: a few needle tufts hanging off each branch.
      const tufts = 4 + Math.floor(r() * 3);
      g.lineTo(W / 2 + side * reach, y + droop * 0.55);
      for (let k = tufts; k >= 0; k--) {
        const x = W / 2 + side * reach * (k / tufts);
        g.lineTo(x + side * 3, y + droop * (0.55 + 0.35 * (k / tufts)) + 3 + 5 * r());
        g.lineTo(x, y + droop * 0.5 * (k / tufts) + 8);
      }
      g.closePath();
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

export class Foreground {
  private group = new THREE.Group();
  private trees: { mesh: THREE.Mesh; phase: number; flex: number }[] = [];
  private mat: THREE.MeshBasicMaterial[] = [];

  constructor(scene: THREE.Scene) {
    const r = rng(8586);
    const geo = new THREE.PlaneGeometry(0.5, 1);
    geo.translate(0, 0.5, 0); // pivot at the base, so sway bends from the ground
    for (let v = 0; v < 3; v++) {
      this.mat.push(new THREE.MeshBasicMaterial({
        map: treeTexture(101 + v), transparent: true, depthTest: false, depthWrite: false,
        side: THREE.DoubleSide, alphaTest: 0.02,
      }));
    }
    // Loose clumps round the compass with open gaps between them.
    let az = r() * 30;
    while (az < 360) {
      const clump = 1 + Math.floor(r() * 2.4);
      for (let k = 0; k < clump; k++) {
        const a = (az + k * (3 + r() * 4)) * (Math.PI / 180);
        const dist = 0.028 + r() * 0.05; // km
        // Size each tree so its tip reaches a chosen height in the sky (9-25 deg).
        const base = -0.011 - r() * 0.006;
        const h = dist * Math.tan((9 + r() * 16) * (Math.PI / 180)) - base;
        const m = new THREE.Mesh(geo, this.mat[Math.floor(r() * 3)]);
        m.position.set(Math.sin(a) * dist, base, -Math.cos(a) * dist);
        m.scale.set(h, h, 1);
        m.rotation.y = -a; // face the observer
        m.renderOrder = 30 - dist; // nearer trees over farther ones
        m.frustumCulled = false;
        this.trees.push({ mesh: m, phase: r() * 6.28, flex: 0.6 + r() * 0.8 });
        this.group.add(m);
      }
      az += 22 + r() * 34;
    }
    scene.add(this.group);
  }

  /** Hide the trees for a pass (the close-up looks past them). */
  show(on: boolean): void {
    this.group.visible = on;
  }

  update(tSec: number, o: { visible: boolean; day: number; moonLit: number; twilight: number; windKmh: number }): void {
    this.group.visible = o.visible;
    if (!o.visible) return;
    const l = 0.0012 + 0.003 * o.moonLit; // linear light: silhouettes stay darker than the sky
    for (const m of this.mat) {
      m.color.setRGB(
        l + 0.010 * o.day + 0.004 * o.twilight,
        l * 1.15 + 0.024 * o.day + 0.002 * o.twilight,
        l * 1.25 + 0.013 * o.day,
      );
    }
    const amp = 0.004 + Math.min(o.windKmh, 40) * 0.0009;
    for (const t of this.trees) {
      t.mesh.rotation.z = amp * t.flex * (Math.sin(tSec * 0.7 + t.phase) + 0.4 * Math.sin(tSec * 1.9 + t.phase * 2.3));
    }
  }
}
