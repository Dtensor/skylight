// Sky Window — the front-wall view. You stand at the configured location and
// look up and out through the wall: real skyline, real sun/moon/stars, real
// satellites, and the live aircraft around you as 3D models.
//
// Keys (a keyboard on the display machine): arrows = turn / tilt, +/- = zoom,
// c = true geometry <-> compressed, [ ] = compression, p = slow pan,
// l = labels, g = ghost satellites, k = clouds, f = foreground trees, h = info line.
// URL overrides for a one-off look: ?heading=&pitch=&fov=&k=&t=<minutes offset>&cloud=<%>

import * as THREE from "three";
import { DEFAULT_CONFIG, type Config } from "@shared/index.js";
import { Connection } from "../lib/connection.js";
import { Sky, dirFromAzEl } from "./sky.js";
import { Horizon } from "./horizon.js";
import { Fleet } from "./aircraft.js";
import { Satellites, type Tle } from "./sats.js";
import { Foreground } from "./foreground.js";

const D2R = Math.PI / 180;
const NM_KM = 1.852;
const SWEEP_SEC = 900; // one slow turn of the compass in "sweep" mode
const KANGCHENJUNGA = { lat: 27.7025, lon: 88.1475, name: "Kangchenjunga", m: 8586 };

const q = new URLSearchParams(location.search);
const num = (k: string): number | undefined => {
  const v = q.get(k);
  return v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
};
const override = { heading: num("heading"), pitch: num("pitch"), fov: num("fov"), k: num("k"), t: num("t"), cloud: num("cloud") };

function fail(msg: string): void {
  const el = document.getElementById("fail")!;
  el.textContent = msg;
  el.style.display = "flex";
}

function start(): void {
  const glCanvas = document.getElementById("gl") as HTMLCanvasElement;
  const ovCanvas = document.getElementById("overlay") as HTMLCanvasElement;
  const ov = ovCanvas.getContext("2d")!;

  // Data first, so a missing GPU still leaves an honest message on the wall.
  const conn = new Connection("display");
  let cfg: Config = DEFAULT_CONFIG;
  let status = conn.state.status;
  let connected = false;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: "high-performance" });
  } catch {
    fail("This display has no WebGL, so the sky window cannot draw here.");
    return;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.sortObjects = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 3000);
  camera.rotation.order = "YXZ";

  const sky = new Sky(scene);
  const horizon = new Horizon(scene);
  const fleet = new Fleet(scene);
  const sats = new Satellites(scene);
  const foreground = new Foreground(scene);
  let windKmh = 5;

  let W = 0;
  let H = 0;
  let dpr = 1;
  const resize = () => {
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    ovCanvas.width = Math.round(W * dpr);
    ovCanvas.height = Math.round(H * dpr);
    ov.setTransform(dpr, 0, 0, dpr, 0, 0);
    camera.aspect = W / H;
  };
  resize();
  window.addEventListener("resize", resize);

  // --- data plumbing ---
  let horizonFor = "";
  let lastSnapshot = -1;
  let showHud = true;
  conn.subscribe((s) => {
    connected = s.connected;
    status = s.status;
    if (s.config) cfg = s.config;
    const key = `${cfg.centerLat},${cfg.centerLon}`;
    if (s.config && key !== horizonFor) {
      horizonFor = key;
      horizon.load(cfg.centerLat, cfg.centerLon).catch((e) => console.warn("[wall] skyline unavailable:", e));
    }
    if (s.now !== lastSnapshot) {
      lastSnapshot = s.now;
      fleet.ingest(s.aircraft, cfg.centerLat, cfg.centerLon, cfg.wallRangeNm * NM_KM * 1.05);
    }
  });
  conn.connect();

  const getJson = async <T,>(url: string): Promise<T | null> => {
    try {
      const r = await fetch(url);
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const loadTles = async () => {
    const t = await getJson<Tle[]>("/api/tle");
    if (t && t.length) sats.setTles(t);
  };
  const loadWeather = async () => {
    const w = await getJson<{ cloud_cover?: number; wind_speed_10m?: number; wind_direction_10m?: number }>("/api/weather");
    windKmh = w?.wind_speed_10m ?? windKmh;
    if (w || override.cloud != null) sky.setWeather(override.cloud ?? w?.cloud_cover ?? 0, windKmh, w?.wind_direction_10m ?? 270);
  };
  void loadTles();
  void loadWeather();
  setInterval(() => void loadTles(), 3600_000);
  setInterval(() => void loadWeather(), 900_000);

  // --- keys ---
  window.addEventListener("keydown", (e) => {
    const c = cfg;
    const patch = (p: Partial<Config>) => conn.patchConfig(p);
    switch (e.key) {
      case "ArrowLeft": patch({ wallHeadingDeg: (c.wallHeadingDeg + 355) % 360 }); break;
      case "ArrowRight": patch({ wallHeadingDeg: (c.wallHeadingDeg + 5) % 360 }); break;
      case "ArrowUp": patch({ wallPitchDeg: Math.min(80, c.wallPitchDeg + 2) }); break;
      case "ArrowDown": patch({ wallPitchDeg: Math.max(0, c.wallPitchDeg - 2) }); break;
      case "+": case "=": patch({ wallFovDeg: Math.max(25, c.wallFovDeg - 3) }); break;
      case "-": patch({ wallFovDeg: Math.min(95, c.wallFovDeg + 3) }); break;
      case "c": patch({ wallCompress: c.wallCompress > 1 ? 1 : 10 }); break;
      case "[": patch({ wallCompress: Math.max(1, c.wallCompress - 1) }); break;
      case "]": patch({ wallCompress: Math.min(30, c.wallCompress + 1) }); break;
      case "p": patch({ wallPan: c.wallPan === "sweep" ? "fixed" : "sweep" }); break;
      case "l": patch({ wallLabels: !c.wallLabels }); break;
      case "g": patch({ wallGhostSats: !c.wallGhostSats }); break;
      case "k": patch({ wallClouds: !c.wallClouds }); break;
      case "f": patch({ wallForeground: !c.wallForeground }); break;
      case "h": showHud = !showHud; break;
    }
  });

  // --- overlay helpers ---
  const ndc = new THREE.Vector3();
  const toScreen = (v: THREE.Vector3): { x: number; y: number } | null => {
    ndc.copy(v).project(camera);
    if (ndc.z > 1 || Math.abs(ndc.x) > 1.02 || Math.abs(ndc.y) > 1.02) return null;
    return { x: (ndc.x * 0.5 + 0.5) * W, y: (-ndc.y * 0.5 + 0.5) * H };
  };
  type Box = [number, number, number, number];
  const taken: Box[] = [];
  const free = (b: Box) => !taken.some((t) => b[0] < t[0] + t[2] && b[0] + b[2] > t[0] && b[1] < t[1] + t[3] && b[1] + b[3] > t[1]);
  const FONT = "'Avenir Next', 'Segoe UI', Roboto, system-ui, sans-serif";

  /** A two-line tag on a dark plate with a leader; picks a free spot or gives up. */
  function tag(p: { x: number; y: number }, l1: string, l2: string, rgb: string, alpha: number, off: number, must: boolean): void {
    const fs = Math.max(11, H * 0.0185);
    ov.font = `600 ${fs}px ${FONT}`;
    const w1 = ov.measureText(l1).width;
    ov.font = `400 ${fs * 0.82}px ${FONT}`;
    const w2 = l2 ? ov.measureText(l2).width : 0;
    const pad = fs * 0.5;
    const w = Math.max(w1, w2) + pad * 2;
    const h = (l2 ? fs * 2.15 : fs * 1.3) + pad;
    const spots: [number, number][] = [[1, -1], [1, 1], [-1, -1], [-1, 1]];
    for (const [sx, sy] of spots) {
      const ax = p.x + sx * off;
      const ay = p.y + sy * off;
      const b: Box = [sx > 0 ? ax : ax - w, sy > 0 ? ay : ay - h, w, h];
      if (b[0] < 4 || b[1] < 4 || b[0] + w > W - 4 || b[1] + h > H - 4) continue;
      if (!free(b) && !(must && sx === -1 && sy === 1)) continue;
      taken.push(b);
      ov.globalAlpha = alpha;
      ov.strokeStyle = `rgba(${rgb},0.55)`;
      ov.lineWidth = 1;
      ov.beginPath();
      ov.moveTo(p.x + sx * off * 0.35, p.y + sy * off * 0.35);
      ov.lineTo(ax, ay);
      ov.stroke();
      ov.fillStyle = "rgba(3,7,14,0.62)";
      ov.fillRect(b[0], b[1], w, h);
      ov.fillStyle = `rgba(${rgb},0.9)`;
      ov.fillRect(sx > 0 ? b[0] : b[0] + w - 2, b[1], 2, h);
      ov.textBaseline = "top";
      ov.font = `600 ${fs}px ${FONT}`;
      ov.fillStyle = "rgba(244,247,255,0.98)";
      ov.fillText(l1, b[0] + pad, b[1] + pad * 0.6);
      if (l2) {
        ov.font = `400 ${fs * 0.82}px ${FONT}`;
        ov.fillStyle = "rgba(190,202,224,0.95)";
        ov.fillText(l2, b[0] + pad, b[1] + pad * 0.6 + fs * 1.18);
      }
      ov.globalAlpha = 1;
      return;
    }
  }

  function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const [a, b, dl] = [lat1 * D2R, lat2 * D2R, (lon2 - lon1) * D2R];
    return (Math.atan2(Math.sin(dl) * Math.cos(b), Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(dl)) / D2R + 360) % 360;
  }

  // --- frame loop ---
  let prev = performance.now();
  let sweep = 0;
  const tmp = new THREE.Vector3();
  const frame = (nowMs: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.25, (nowMs - prev) / 1000);
    prev = nowMs;
    const tSec = nowMs / 1000;
    if (W !== window.innerWidth || H !== window.innerHeight) resize();

    const date = new Date(Date.now() + ((override.t ?? 0) + cfg.skyTimeOffsetMin) * 60_000);
    if (cfg.wallPan === "sweep") sweep = (sweep + (dt / SWEEP_SEC) * 360) % 360;
    const heading = ((override.heading ?? cfg.wallHeadingDeg) + (cfg.wallPan === "sweep" ? sweep : 0)) % 360;
    const pitch = override.pitch ?? cfg.wallPitchDeg;
    const compress = override.k ?? cfg.wallCompress;
    camera.fov = override.fov ?? cfg.wallFovDeg;
    camera.rotation.set(pitch * D2R, -heading * D2R, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const pixelScale = dpr * (H / 1080);
    sky.setCloudsVisible(cfg.wallClouds);
    sky.update(date, cfg.centerLat, cfg.centerLon, dt, tSec, pixelScale, camera);
    const st = sky.state;
    const moonLit = sky.uniforms.uMoonLit.value;
    horizon.uniforms.uDay.value = st.day;
    horizon.uniforms.uTwilight.value = st.twilight;
    horizon.uniforms.uMoonLit.value = moonLit;
    const observerKm = (horizon.info?.observerM ?? 1200) / 1000;
    fleet.update(dt, tSec, {
      compress, observerKm, day: st.day, twilight: st.twilight, moonLit,
      sunDir: sky.uniforms.uSunDir.value, staleSec: cfg.staleSec,
    });
    sats.update(date, cfg.centerLat, cfg.centerLon, {
      sunAlt: st.sunAlt, ghosts: cfg.wallGhostSats, pixelScale, observerKm,
    });
    foreground.update(tSec, { visible: cfg.wallForeground, day: st.day, moonLit, twilight: st.twilight, windKmh });
    renderer.render(scene, camera);

    // ---- 2D overlay: compass, tags, info line ----
    ov.clearRect(0, 0, W, H);
    taken.length = 0;
    const fs = Math.max(11, H * 0.0185);

    // Compass marks standing on the horizon, so the wall reads as a real direction.
    for (let az = 0; az < 360; az += 15) {
      const p = toScreen(dirFromAzEl(az, 0, tmp).multiplyScalar(700));
      if (!p) continue;
      const major = az % 45 === 0;
      const name = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][az / 45];
      ov.fillStyle = `rgba(210,222,245,${major ? 0.7 : 0.3})`;
      ov.fillRect(p.x - 0.5, p.y - (major ? fs * 0.7 : fs * 0.35), 1, major ? fs * 0.7 : fs * 0.35);
      if (major) {
        ov.font = `600 ${fs * 0.95}px ${FONT}`;
        ov.textAlign = "center";
        ov.textBaseline = "top";
        ov.fillStyle = "rgba(0,0,0,0.55)";
        ov.fillText(name, p.x + 1, p.y + fs * 0.25 + 1);
        ov.fillStyle = "rgba(226,234,250,0.88)";
        ov.fillText(name, p.x, p.y + fs * 0.25);
        ov.textAlign = "left";
      }
    }

    if (cfg.wallLabels) {
      // Aircraft: nearest first, so the closest always wins a tag.
      const ac = [...fleet.views].sort((a, b) => a.rangeKm - b.rangeKm);
      ac.forEach((v, i) => {
        const p = toScreen(v.pos);
        if (!p || v.el < horizon.skylineAt(v.az)) return; // hidden behind the hills
        const a = v.ac;
        const altFt = a.altGeom ?? a.altBaro ?? 0;
        const vr = a.baroRate ?? 0;
        const arrow = vr > 300 ? " ↑" : vr < -300 ? " ↓" : "";
        const l1 = `${(a.flight || a.registration || a.hex.toUpperCase()).trim()}${a.typeCode ? "  " + a.typeCode : ""}`;
        const route = a.origin && a.destination ? `  ${a.origin}→${a.destination}` : "";
        const l2 = `${altFt >= 18000 ? "FL" + Math.round(altFt / 100) : Math.round(altFt / 100) * 100 + " ft"}${arrow} · ${Math.round(v.rangeKm)} km${route}`;
        if (i < 8) {
          tag(p, l1, l2, "140,200,255", v.alpha, H * 0.05, i < 3);
        } else {
          // Further traffic: callsign only, so the sky is not papered with tags.
          ov.font = `500 ${fs * 0.8}px ${FONT}`;
          const name = (a.flight || a.hex).trim();
          const box: Box = [p.x + H * 0.022, p.y - H * 0.016 - fs * 0.5, ov.measureText(name).width, fs];
          if (!free(box)) return;
          taken.push(box);
          ov.textBaseline = "middle";
          ov.fillStyle = "rgba(0,0,0,0.6)";
          ov.fillText((a.flight || a.hex).trim(), p.x + H * 0.022 + 1, p.y - H * 0.016 + 1);
          ov.fillStyle = `rgba(190,214,245,${0.75 * v.alpha})`;
          ov.fillText((a.flight || a.hex).trim(), p.x + H * 0.022, p.y - H * 0.016);
        }
      });
      for (const s of sats.views) {
        if (!s.shining && !s.iss) continue;
        const p = toScreen(s.pos);
        if (!p) continue;
        tag(p, s.name, `${Math.round(s.heightKm)} km up · ${Math.round(s.rangeKm)} km away${s.shining ? "" : " · in shadow"}`, "255,226,150", s.shining ? 1 : 0.6, H * 0.03, s.iss);
      }
      for (const b of st.named) {
        const p = toScreen(dirFromAzEl(b.az, b.alt, tmp).multiplyScalar(880));
        if (p) tag(p, b.name, "", b.kind === "planet" ? "255,206,150" : "170,180,205", b.kind === "planet" ? 0.9 : 0.55, H * 0.022, false);
      }
      if (st.moonAlt > 0) {
        const p = toScreen(dirFromAzEl(st.moonAz, st.moonAlt, tmp).multiplyScalar(880));
        if (p) tag(p, "Moon", `${Math.round(st.moonIllum * 100)}% lit`, "200,210,235", 0.7, H * 0.035, false);
      }
      const pk = horizon.info?.peak;
      if (pk) {
        const bz = bearing(cfg.centerLat, cfg.centerLon, KANGCHENJUNGA.lat, KANGCHENJUNGA.lon);
        const near = Math.abs(((pk.az - bz + 540) % 360) - 180) < 4;
        const p = toScreen(dirFromAzEl(pk.az, pk.el, tmp).multiplyScalar(790));
        if (p) tag(p, near ? KANGCHENJUNGA.name : `${Math.round(pk.heightM).toLocaleString()} m`, near ? `${KANGCHENJUNGA.m.toLocaleString()} m` : "highest on the skyline", "215,225,240", 0.75, H * 0.03, false);
      }
    }

    if (showHud) {
      const time = date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      const feed = !connected ? "connecting…" : status && !status.ok ? "aircraft feed down" : `${fleet.views.length} aircraft`;
      const light = st.sunAlt > 0 ? "day" : st.sunAlt > -6 ? "twilight" : st.sunAlt > -18 ? "dusk" : "night";
      const line = [
        `${Math.abs(cfg.centerLat).toFixed(2)}°${cfg.centerLat >= 0 ? "N" : "S"} ${Math.abs(cfg.centerLon).toFixed(2)}°${cfg.centerLon >= 0 ? "E" : "W"}`,
        time, light, feed,
        `${sats.counts.up} satellites up${sats.counts.shining ? `, ${sats.counts.shining} shining` : ""}`,
        `facing ${Math.round(heading)}°`,
        compress > 1 ? `aircraft distance ÷${compress}` : "true geometry",
      ].join("   ·   ");
      ov.font = `500 ${fs * 0.82}px ${FONT}`;
      ov.textBaseline = "bottom";
      ov.fillStyle = "rgba(0,0,0,0.5)";
      ov.fillText(line, H * 0.022 + 1, H - H * 0.018 + 1);
      ov.fillStyle = "rgba(205,216,238,0.8)";
      ov.fillText(line, H * 0.022, H - H * 0.018);
    }
  };
  requestAnimationFrame(frame);
}

// An old TV browser fails silently; put the reason on the wall instead.
window.addEventListener("error", (e) => fail(`Sky window stopped: ${e.message}`));
start();
