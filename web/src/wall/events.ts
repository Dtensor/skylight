// Chance events — the things a real sky does when you are not expecting it.
// Meteors streak across at night (from the Leonid radiant in mid-November when
// it is up, otherwise sporadic); birds cross by day and a lone owl by night.
// These are ambience: simulated, not detected.

import * as THREE from "three";
import type { Sky } from "./sky.js";

const D2R = Math.PI / 180;
const R = 870;

const METEOR_VERT = /* glsl */ `
attribute float aT;
attribute float aSide;
varying float vT;
varying float vSide;
void main() {
  vT = aT;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const METEOR_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uA;
varying float vT;
varying float vSide;
void main() {
  float across = 1.0 - vSide * vSide;
  float head = pow(vT, 2.2);
  gl_FragColor = vec4(mix(uColor, vec3(1.0), head * 0.7), across * across * (0.08 + 0.92 * head) * uA);
}`;

interface Meteor {
  mesh: THREE.Mesh;
  uniforms: { uColor: { value: THREE.Color }; uA: { value: number } };
  start: THREE.Vector3;
  side: THREE.Vector3; // great-circle direction at the start, unit, perpendicular to start
  t: number;
  dur: number;
  arc: number; // total travel, radians
  width: number;
  peak: number;
}

export class Meteors {
  private pool: Meteor[] = [];
  private next = 12 + Math.random() * 20;
  /** Count since start, so the info line can mention it. */
  seen = 0;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
      g.setAttribute("aT", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 1]), 1));
      g.setAttribute("aSide", new THREE.BufferAttribute(new Float32Array([-1, 1, -1, 1]), 1));
      g.setIndex([0, 1, 2, 1, 3, 2]);
      const uniforms = { uColor: { value: new THREE.Color(0.75, 0.9, 1) }, uA: { value: 0 } };
      const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
        uniforms, vertexShader: METEOR_VERT, fragmentShader: METEOR_FRAG,
        transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }));
      mesh.renderOrder = 1.2;
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      this.pool.push({ mesh, uniforms, start: new THREE.Vector3(), side: new THREE.Vector3(), t: 0, dur: 1, arc: 0, width: 1, peak: 1 });
    }
  }

  private spawn(m: Meteor, sky: Sky, date: Date, headingDeg: number): void {
    // Start somewhere the viewer is looking, so the chance is not wasted.
    const az = (headingDeg + (Math.random() - 0.5) * 110) * D2R;
    const el = (18 + Math.random() * 50) * D2R;
    m.start.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const leonids = date.getUTCMonth() === 10 && date.getUTCDate() >= 6;
    const radiant = sky.eqToWorld(152, 22);
    if (leonids && radiant.y > 0.05 && Math.random() < 0.7) {
      // Away from the radiant along the great circle through it.
      m.side.copy(m.start).multiplyScalar(m.start.dot(radiant)).sub(radiant).normalize();
    } else {
      m.side.set(Math.random() - 0.5, -0.25 - Math.random() * 0.6, Math.random() - 0.5);
      m.side.addScaledVector(m.start, -m.side.dot(m.start)).normalize();
    }
    const fireball = Math.random() < 0.12;
    m.t = 0;
    m.dur = 0.45 + Math.random() * 0.6 + (fireball ? 0.5 : 0);
    m.arc = (7 + Math.random() * 14 + (fireball ? 8 : 0)) * D2R;
    m.width = R * Math.tan((fireball ? 0.16 : 0.07) * D2R);
    m.peak = fireball ? 1.6 : 0.55 + Math.random() * 0.5;
    m.uniforms.uColor.value.setRGB(fireball ? 0.55 : 0.75, fireball ? 1.0 : 0.9, fireball ? 0.75 : 1.0);
    m.mesh.visible = true;
    this.seen++;
  }

  update(dt: number, o: { dark: number; sky: Sky; date: Date; headingDeg: number }): void {
    this.next -= dt;
    if (this.next <= 0) {
      this.next = 28 + Math.random() * 62;
      const free = this.pool.find((m) => !m.mesh.visible);
      if (free && o.dark > 0.6) this.spawn(free, o.sky, o.date, o.headingDeg);
    }
    const head = new THREE.Vector3();
    const tail = new THREE.Vector3();
    const perp = new THREE.Vector3();
    for (const m of this.pool) {
      if (!m.mesh.visible) continue;
      m.t += dt;
      const u = m.t / m.dur;
      if (u >= 1.35) {
        m.mesh.visible = false;
        continue;
      }
      const at = (ang: number, out: THREE.Vector3) => out.copy(m.start).multiplyScalar(Math.cos(ang)).addScaledVector(m.side, Math.sin(ang)).multiplyScalar(R);
      const a1 = m.arc * Math.min(u, 1);
      const a0 = Math.max(0, a1 - m.arc * 0.45 * Math.min(1, u * 2.5));
      at(a1, head);
      at(a0, tail);
      perp.crossVectors(head, tail).normalize().multiplyScalar(m.width);
      const pos = m.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      (pos.array as Float32Array).set([
        tail.x - perp.x, tail.y - perp.y, tail.z - perp.z, tail.x + perp.x, tail.y + perp.y, tail.z + perp.z,
        head.x - perp.x, head.y - perp.y, head.z - perp.z, head.x + perp.x, head.y + perp.y, head.z + perp.z,
      ]);
      pos.needsUpdate = true;
      const env = u < 1 ? Math.pow(Math.sin(Math.PI * Math.min(u * 1.15, 1)), 0.6) : Math.max(0, 1 - (u - 1) / 0.35) * 0.4;
      m.uniforms.uA.value = env * m.peak * o.dark * (head.y > 0 ? 1 : 0);
    }
  }
}

interface Bird {
  group: THREE.Group;
  wings: [THREE.Mesh, THREE.Mesh];
  offset: THREE.Vector3;
  phase: number;
  hz: number;
}

/** Birds by day, one owl by night: near silhouettes that cross in front of everything. */
export class Flyers {
  private birds: Bird[] = [];
  private mat = new THREE.MeshBasicMaterial({ color: 0x05070a, side: THREE.DoubleSide, transparent: true, depthTest: false, depthWrite: false });
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private left = 0;
  private count = 0;
  private next = 25 + Math.random() * 30;
  /** Called when the night owl sets off, with its side of the view (-1 left .. 1 right). */
  onOwl: (pan: number) => void = () => undefined;

  constructor(scene: THREE.Scene) {
    const wing = new THREE.BufferGeometry();
    wing.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, -0.32, 0, 0, 0.3, 1, 0, 0.02, 0.55, 0, -0.3], 3));
    wing.setIndex([0, 1, 2, 0, 2, 3]);
    for (let i = 0; i < 11; i++) {
      const group = new THREE.Group();
      const a = new THREE.Mesh(wing, this.mat);
      const b = new THREE.Mesh(wing, this.mat);
      b.scale.x = -1;
      for (const w of [a, b]) {
        w.renderOrder = 40;
        w.frustumCulled = false;
      }
      group.add(a, b);
      group.visible = false;
      scene.add(group);
      this.birds.push({ group, wings: [a, b], offset: new THREE.Vector3(), phase: Math.random() * 6.28, hz: 3 });
    }
  }

  update(dt: number, tSec: number, o: { day: number; twilight: number; headingDeg: number; pitchDeg: number }): void {
    const light = 0.012 + 0.05 * o.day + 0.015 * o.twilight;
    this.mat.color.setRGB(light, light * 1.05, light * 1.15);
    this.next -= dt;
    if (this.next <= 0 && this.left <= 0) {
      const night = o.day < 0.15 && o.twilight < 0.3;
      this.next = night ? 110 + Math.random() * 170 : 45 + Math.random() * 90;
      // Cross the view from one side to the other, a little above its centre.
      const dir = Math.random() < 0.5 ? -1 : 1;
      const h = o.headingDeg * D2R;
      const fwd = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
      const right = new THREE.Vector3(Math.cos(h), 0, Math.sin(h));
      const dist = night ? 0.035 + Math.random() * 0.03 : 0.07 + Math.random() * 0.12;
      const up = dist * Math.tan((o.pitchDeg + (Math.random() - 0.35) * 18) * D2R);
      const span = dist * 1.6;
      this.pos.copy(fwd).multiplyScalar(dist).addScaledVector(right, -dir * span).setY(up);
      const speed = night ? 0.007 : 0.011; // km/s
      this.vel.copy(right).multiplyScalar(dir * speed).setY((Math.random() - 0.5) * 0.0012);
      this.left = (span * 2) / speed;
      this.count = night ? 1 : 4 + Math.floor(Math.random() * 7);
      const size = night ? 0.00062 : 0.00030 + Math.random() * 0.00012;
      this.birds.forEach((b, i) => {
        b.group.visible = i < this.count;
        b.group.scale.setScalar(size);
        b.hz = night ? 2.1 : 3.4 + Math.random() * 1.6;
        // A loose skein trailing back from the leader.
        const row = Math.ceil(i / 2);
        b.offset.copy(right).multiplyScalar(-dir * row * 0.0016 * (1 + Math.random() * 0.4))
          .addScaledVector(fwd, (i % 2 ? 1 : -1) * row * 0.0011).setY((Math.random() - 0.5) * 0.0012);
        b.group.rotation.y = Math.atan2(-fwd.x, -fwd.z) + (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      });
      if (night) this.onOwl(-dir * 0.6);
    }
    if (this.left > 0) {
      this.left -= dt;
      this.pos.addScaledVector(this.vel, dt);
      for (let i = 0; i < this.count; i++) {
        const b = this.birds[i];
        b.group.position.copy(this.pos).add(b.offset);
        b.group.position.y += Math.sin(tSec * b.hz * 6.28 + b.phase) * 0.00012;
        const flap = Math.sin(tSec * b.hz * 6.28 + b.phase) * 0.62;
        b.wings[0].rotation.z = flap;
        b.wings[1].rotation.z = -flap;
      }
      if (this.left <= 0) for (const b of this.birds) b.group.visible = false;
    }
  }
}
