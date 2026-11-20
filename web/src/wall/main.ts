// Sky Window — the front-wall view. You stand at the configured location and
// look up and out through the wall: real skyline, real sun/moon/stars, real
// satellites, and the live aircraft around you as 3D models.
//
// Keys (a keyboard on the display machine): arrows = turn / tilt, +/- = zoom,
// c = true geometry <-> compressed, [ ] = compression, p = slow pan,
// l = labels, g = ghost satellites, k = clouds, f = foreground trees, h = info line,
// m = sound, s = close-up panel, i = "right now" notes, r = radio and cabin, v = spoken voice.
// URL overrides for a one-off look: ?heading=&pitch=&fov=&k=&t=<minutes offset>&cloud=<%>

import * as THREE from "three";
import * as Astronomy from "astronomy-engine";
import { DEFAULT_CONFIG, displayHex, type Config } from "@shared/index.js";
import { Connection } from "../lib/connection.js";
import { airportEta } from "../lib/eta.js";
import { AIRPORTS } from "../display/airports.js";
import { Sky, dirFromAzEl } from "./sky.js";
import { Horizon } from "./horizon.js";
import { Fleet, type CraftView } from "./aircraft.js";
import { Satellites, type Tle } from "./sats.js";
import { Foreground } from "./foreground.js";
import { Meteors, Flyers } from "./events.js";
import { Soundscape, type Voice } from "./audio.js";
import { Lore, type LoreLine, type Extra, type Point, type Seen } from "./lore.js";
import { Radio, type RadioCall } from "./radio.js";

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
const showFps = q.get("fps") === "1";
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg: number): string => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const n0 = (v: number): string => Math.round(v).toLocaleString("en-US");

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
  const meteors = new Meteors(scene);
  const flyers = new Flyers(scene);
  const sound = new Soundscape();
  // Reachable from the WebView's remote debugger, to read the audio state.
  (window as unknown as { skySound?: Soundscape }).skySound = sound;
  flyers.onOwl = (pan) => sound.owl(pan);
  const scopeCam = new THREE.PerspectiveCamera(8, 1, 0.01, 3000);
  let windKmh = 5;
  let windDir = 270;
  let placeTz: string | undefined;
  let dprCap = 1.5;

  let W = 0;
  let H = 0;
  let dpr = 1;
  const resize = () => {
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    ovCanvas.width = Math.round(W * dpr);
    ovCanvas.height = Math.round(H * dpr);
    ov.setTransform(dpr, 0, 0, dpr, 0, 0);
    camera.aspect = W / H;
  };
  resize();
  window.addEventListener("resize", resize);

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
    windDir = w?.wind_direction_10m ?? windDir;
    if (w || override.cloud != null) sky.setWeather(override.cloud ?? w?.cloud_cover ?? 0, windKmh, w?.wind_direction_10m ?? 270);
  };

  // --- data plumbing ---
  let horizonFor = "";
  let lastSnapshot = -1;
  const seenAlerts = new Set<string>();
  let alertsPrimed = false;
  let alertFocus: { hex: string; until: number } | null = null;
  let showHud = true;
  conn.subscribe((s) => {
    connected = s.connected;
    status = s.status;
    // New notable-aircraft alerts: chime once, and steer the close-up to it.
    for (const a of s.alerts) {
      if (seenAlerts.has(a.id)) continue;
      seenAlerts.add(a.id);
      if (!alertsPrimed || Date.now() - a.at > 120_000) continue; // backlog: no chime
      alertFocus = { hex: a.hex, until: performance.now() / 1000 + 120 };
      if (cfg.alertChime && a.chime && cfg.wallSound) sound.chime(a.kind === "emergency");
    }
    alertsPrimed = true;
    if (s.config) cfg = s.config;
    const key = `${cfg.centerLat},${cfg.centerLon}`;
    if (s.config && key !== horizonFor) {
      horizonFor = key;
      horizon.load(cfg.centerLat, cfg.centerLon).catch((e) => console.warn("[wall] skyline unavailable:", e));
      placeTz = undefined;
      void getJson<Point>(`/api/point?lat=${cfg.centerLat}&lon=${cfg.centerLon}`).then((pt) => {
        if (pt?.timezone && key === horizonFor) placeTz = pt.timezone;
      });
      void loadWeather();
    }
    if (s.now !== lastSnapshot) {
      lastSnapshot = s.now;
      fleet.ingest(s.aircraft, cfg.centerLat, cfg.centerLon, cfg.wallRangeNm * NM_KM * 1.05);
    }
  });
  conn.connect();

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
      case "m": patch({ wallSound: !c.wallSound }); break;
      case "s": patch({ wallScope: !c.wallScope }); break;
      case "i": patch({ wallMoments: !c.wallMoments }); break;
      case "r": patch({ wallRadio: !c.wallRadio }); break;
      case "v": patch({ wallSpeak: !c.wallSpeak }); break;
    }
    sound.unlock();
  });
  window.addEventListener("pointerdown", () => sound.unlock());

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
  let dayNow = 0;
  const FONT = "'Avenir Next', 'Segoe UI', Roboto, system-ui, sans-serif";

  /** A two-line tag on a dark plate with a leader; picks a free spot or gives up. */
  function tag(p: { x: number; y: number }, l1: string, l2: string, rgb: string, alpha: number, off: number, must: boolean): void {
    const fs = Math.max(11, H * 0.0185 * (cfg.wallTextScale || 1));
    ov.font = `600 ${fs}px ${FONT}`;
    const w1 = ov.measureText(l1).width;
    ov.font = `500 ${fs * 0.94}px ${FONT}`;
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
      ov.fillStyle = `rgba(3,7,14,${0.8 + 0.12 * dayNow})`;
      ov.fillRect(b[0], b[1], w, h);
      ov.fillStyle = `rgba(${rgb},0.9)`;
      ov.fillRect(sx > 0 ? b[0] : b[0] + w - 2, b[1], 2, h);
      ov.textBaseline = "top";
      ov.font = `600 ${fs}px ${FONT}`;
      ov.fillStyle = "rgba(244,247,255,0.98)";
      ov.fillText(l1, b[0] + pad, b[1] + pad * 0.6);
      if (l2) {
        ov.font = `500 ${fs * 0.94}px ${FONT}`;
        ov.fillStyle = "rgba(228,235,250,1)";
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

  // --- the close-up: which aircraft, and its card ---
  let focusHex = "";
  let focusSince = -1e9;
  function pickFocus(tSec: number, list: CraftView[], onScreen: Set<string>): CraftView | null {
    // A fresh alert takes the close-up for up to two minutes.
    if (alertFocus && tSec < alertFocus.until) {
      const hot = list.find((v) => v.ac.hex === alertFocus!.hex);
      if (hot) {
        if (focusHex !== hot.ac.hex) {
          focusHex = hot.ac.hex;
          focusSince = tSec;
        }
        return hot;
      }
    }
    const pool = list.filter((v) => onScreen.has(v.ac.hex));
    const cands = pool.length ? pool : list;
    const cur = list.find((v) => v.ac.hex === focusHex);
    if (cur && tSec - focusSince < 22 && (onScreen.has(focusHex) || !pool.length)) return cur;
    if (!cands.length) {
      focusHex = "";
      return null;
    }
    const nxt = cands[(cands.findIndex((v) => v.ac.hex === focusHex) + 1) % cands.length];
    if (nxt.ac.hex !== focusHex) {
      focusHex = nxt.ac.hex;
      focusSince = tSec;
    }
    return nxt;
  }

  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    ov.beginPath();
    ov.moveTo(x + r, y);
    ov.arcTo(x + w, y, x + w, y + h, r);
    ov.arcTo(x + w, y + h, x, y + h, r);
    ov.arcTo(x, y + h, x, y, r);
    ov.arcTo(x, y, x + w, y, r);
    ov.closePath();
  }

  /** Bezel, ring and information card for the aircraft in the close-up. */
  function drawScope(v: CraftView, g: { cx: number; cy: number; R: number }, zoom: number, alpha: number, observerKm: number, p: { x: number; y: number } | null): void {
    const fs = Math.max(11, H * 0.0185 * (cfg.wallTextScale || 1));
    const { cx, cy, R } = g;
    const a = v.ac;
    ov.globalAlpha = 1;
    // Bezel: a dark rounded plate with the circular window cut out of it.
    const m = H * 0.012;
    ov.fillStyle = "#04070d";
    roundRect(cx - R - m, cy - R - m, 2 * (R + m), 2 * (R + m), H * 0.03);
    ov.moveTo(cx + R, cy);
    ov.arc(cx, cy, R, 0, Math.PI * 2, true);
    ov.fill("evenodd");
    if (alpha < 1) { // fade the window in when the subject changes
      ov.fillStyle = `rgba(4,7,13,${1 - alpha})`;
      ov.beginPath();
      ov.arc(cx, cy, R, 0, Math.PI * 2);
      ov.fill();
    }
    ov.strokeStyle = "rgba(150,205,255,0.55)";
    ov.lineWidth = 1.5;
    ov.beginPath();
    ov.arc(cx, cy, R, 0, Math.PI * 2);
    ov.stroke();
    ov.strokeStyle = "rgba(150,205,255,0.35)";
    ov.lineWidth = 1;
    for (let k = 0; k < 4; k++) {
      const [ux, uy] = [Math.cos((k * Math.PI) / 2), Math.sin((k * Math.PI) / 2)];
      ov.beginPath();
      ov.moveTo(cx + ux * R * 0.86, cy + uy * R * 0.86);
      ov.lineTo(cx + ux * R, cy + uy * R);
      ov.stroke();
    }
    ov.font = `600 ${fs * 0.78}px ${FONT}`;
    ov.textAlign = "center";
    ov.textBaseline = "top";
    ov.fillStyle = "rgba(200,226,255,1)";
    ov.fillText(`CLOSER LOOK  ·  ${Math.round(zoom)}×`, cx, cy + R + m + fs * 0.35);
    ov.textAlign = "left";

    // The card.
    const altFt = a.altGeom ?? a.altBaro ?? 0;
    const vr = a.baroRate ?? 0;
    const kmh = (a.gs ?? 0) * NM_KM;
    const trueEl = Math.asin(Math.max(-1, Math.min(1, (altFt * 0.0003048 - observerKm) / Math.max(v.rangeKm, 0.1)))) / D2R;
    const route = a.originName && a.destName ? `${a.originName}  →  ${a.destName}`
      : a.origin && a.destination ? `${a.origin}  →  ${a.destination}` : "Route not published";
    const eta = cfg.showAirportEta ? airportEta(a, AIRPORTS) : null;
    const routeLine = eta ? `${route}  ·  ${eta.text}` : route;
    const soundMin = v.rangeKm / 0.34 / 60;
    const cells: [string, string][] = [
      ["ALTITUDE", `${n0(altFt)} ft  ·  ${n0(altFt * 0.3048)} m`],
      ["SPEED", a.gs != null ? `${n0(kmh)} km/h` : "—"],
      ["HEADING", a.track != null ? `${Math.round(a.track)}°  ${compass(a.track)}` : "—"],
      ["DISTANCE", `${n0(v.rangeKm)} km to the ${compass(v.az)}`],
      ["VERTICAL", Math.abs(vr) < 200 ? "level" : `${vr > 0 ? "climbing" : "descending"} ${n0(Math.abs(vr))} ft/min`],
      ["REGISTRATION", a.registration || displayHex(a.hex)],
    ];
    const pad = fs * 0.95;
    const cw = Math.min(H * 0.6 * Math.max(1, (cfg.wallTextScale || 1) * 0.95), W * 0.5);
    const ch = pad * 2 + fs * (0.9 + 2.25 + 1.75 + 2 * 2.5 + 1.2);
    // The card sits top right, above the close-up; if the aircraft itself is
    // there, it drops to the middle of the right-hand side instead.
    const x0 = W - H * 0.06 - cw;
    let y0 = H * 0.05;
    const b0 = H * 0.04;
    if (p && p.x > x0 - b0 && p.y < y0 + ch + b0) y0 = Math.max(y0, cy - R - m - H * 0.03 - ch);
    taken.push([x0, y0, cw, ch], [cx - R - m, cy - R - m, 2 * (R + m), 2 * (R + m) + fs * 1.4]);
    ov.globalAlpha = alpha;
    ov.fillStyle = "rgba(4,9,18,0.9)";
    roundRect(x0, y0, cw, ch, H * 0.012);
    ov.fill();
    ov.fillStyle = "rgba(140,200,255,0.9)";
    ov.fillRect(x0, y0 + H * 0.012, 2.5, ch - H * 0.024);
    let y = y0 + pad;
    ov.textBaseline = "top";
    ov.font = `600 ${fs * 0.84}px ${FONT}`;
    ov.fillStyle = "rgba(150,205,255,0.95)";
    ov.fillText((a.airline || "Private / unlisted operator").toUpperCase(), x0 + pad, y);
    y += fs * 1.0;
    ov.font = `700 ${fs * 1.9}px ${FONT}`;
    ov.fillStyle = "rgba(248,250,255,1)";
    const call = (a.flight || a.registration || a.hex.toUpperCase()).trim();
    ov.fillText(call, x0 + pad, y);
    const cwid = ov.measureText(call).width;
    ov.font = `500 ${fs * 1.0}px ${FONT}`;
    ov.fillStyle = "rgba(228,235,250,1)";
    ov.fillText(a.typeName || a.typeCode || "", x0 + pad + cwid + fs * 0.8, y + fs * 0.8, cw - pad * 2 - cwid - fs * 0.8);
    y += fs * 2.3;
    ov.font = `500 ${fs * 1.12}px ${FONT}`;
    ov.fillStyle = "rgba(255,226,170,0.98)";
    ov.fillText(routeLine, x0 + pad, y, cw - pad * 2);
    y += fs * 1.9;
    const colW = (cw - pad * 2) / 3;
    cells.forEach(([k, val], i) => {
      const xx = x0 + pad + (i % 3) * colW;
      const yy = y + Math.floor(i / 3) * fs * 2.5;
      ov.font = `600 ${fs * 0.74}px ${FONT}`;
      ov.fillStyle = "rgba(178,200,232,1)";
      ov.fillText(k, xx, yy);
      ov.font = `500 ${fs * 0.95}px ${FONT}`;
      ov.fillStyle = "rgba(236,241,252,0.98)";
      ov.fillText(val, xx, yy + fs * 0.85, colW - fs * 0.5);
    });
    y += fs * 5.0;
    ov.font = `500 ${fs * 0.88}px ${FONT}`;
    ov.fillStyle = "rgba(222,230,246,1)";
    const foot = `Really ${trueEl.toFixed(1)}° above your horizon  ·  its sound would need ${soundMin < 1 ? Math.round(soundMin * 60) + " s" : Math.round(soundMin) + " min"} to reach you${a.squawk ? "  ·  squawk " + a.squawk : ""}`;
    ov.fillText(foot, x0 + pad, y, cw - pad * 2);

    // Brackets on the aircraft itself, and a hairline to its card.
    if (p) {
      const b = H * 0.03;
      ov.strokeStyle = "rgba(150,205,255,0.8)";
      ov.lineWidth = 1.2;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ov.beginPath();
        ov.moveTo(p.x + sx * b, p.y + sy * b * 0.55);
        ov.lineTo(p.x + sx * b, p.y + sy * b);
        ov.lineTo(p.x + sx * b * 0.55, p.y + sy * b);
        ov.stroke();
      }
      ov.strokeStyle = "rgba(150,205,255,0.28)";
      ov.setLineDash([3, 5]);
      ov.beginPath();
      ov.moveTo(p.x + (x0 > p.x ? b : -b), y0 > p.y ? p.y + b : p.y - b);
      ov.lineTo(Math.max(x0, Math.min(x0 + cw, p.x)), y0 > p.y ? y0 : y0 + ch);
      ov.stroke();
      ov.setLineDash([]);
    }
    ov.globalAlpha = 1;
  }

  // --- "right now": small true facts that drift through the corner ---
  const known = new Set<string>();
  const arrivals: string[] = [];
  const lore = new Lore();
  let moment: LoreLine | null = null;
  let momentAt = -1e9;
  let lastFocus: CraftView | null = null;
  let momentIdx = 0;

  // --- what we look up about the aircraft in the close-up ---
  const extras = new Map<string, Extra>();
  function lookUp(v: CraftView): void {
    const a = v.ac;
    if (extras.has(a.hex)) return;
    if (extras.size > 150) extras.clear();
    const x: Extra = {};
    extras.set(a.hex, x);
    void getJson<Seen>(`/api/seen?hex=${a.hex}&flight=${encodeURIComponent((a.flight ?? "").trim())}`).then((r) => (x.seen = r));
    if (a.destLat != null && a.destLon != null) void getJson<Point>(`/api/point?lat=${a.destLat}&lon=${a.destLon}`).then((r) => (x.dest = r));
    if (a.lat != null && a.lon != null && (a.altGeom ?? a.altBaro ?? 0) > 28000) {
      void getJson<Point>(`/api/point?lat=${a.lat.toFixed(1)}&lon=${a.lon.toFixed(1)}`).then((r) => (x.aloft = r));
    }
  }

  // --- the radio and the cabin speaker: reconstructed, one exchange at a time ---
  const radio = new Radio();
  let call: RadioCall | null = null;
  let callAt = -1e9;
  let callFor = 0;
  let lastObserve = 0;
  // A cast of real voices. The controller is one steady voice for the place
  // (American over the Americas, British elsewhere); every aircraft keeps its
  // own pilot, chosen from its address, and its own cabin crew member.
  const PILOTS = ["am_adam", "am_puck", "bm_lewis", "af_sarah", "am_michael", "bf_isabella", "bm_george", "af_nicole"];
  const CREW = ["af_heart", "bf_emma", "af_bella", "af_sky"];
  const voiceFor = (who: string, hex: string): string => {
    const n = parseInt(hex.slice(-4), 16) || 0;
    // South Asia gets the gruff controller designed for Delhi.
    const southAsia = cfg.centerLon > 60 && cfg.centerLon < 98 && cfg.centerLat > 5 && cfg.centerLat < 38;
    const ctl = southAsia ? "gruff" : cfg.centerLon < -30 && cfg.centerLon > -170 ? "am_michael" : "bm_george";
    if (who === "CABIN CREW") return CREW[n % CREW.length];
    if (who !== "PILOT" && who !== "CAPTAIN") return ctl;
    const pool = PILOTS.filter((v) => v !== ctl);
    return pool[n % pool.length];
  };
  const sayUrl = (t: string, voice: string, fast: boolean): string =>
    `/api/say?v=${voice}${fast ? "&fast=1" : ""}&t=${encodeURIComponent(t.replace(/[^A-Za-z0-9 ,.'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240))}`;
  function wrap(text: string, maxW: number): string[] {
    const lines: string[] = [];
    let cur = "";
    for (const word of text.split(" ")) {
      const tryLine = cur ? cur + " " + word : word;
      if (cur && ov.measureText(tryLine).width > maxW) {
        lines.push(cur);
        cur = word;
      } else {
        cur = tryLine;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }
  const started = performance.now() / 1000;
  function nextMoment(date: Date, views: CraftView[]): string {
    if (arrivals.length) return arrivals.shift()!;
    const st = sky.state;
    const facts: (() => string | null)[] = [
      () => {
        const pl = st.named.filter((b) => b.kind === "planet")[0];
        if (!pl) return null;
        const body = Astronomy.Body[pl.name as keyof typeof Astronomy.Body] as Astronomy.Body;
        const min = Astronomy.GeoVector(body, date, true).Length() * 8.3168;
        return `The light you see from ${pl.name} left it ${min >= 90 ? (min / 60).toFixed(1) + " hours" : Math.round(min) + " minutes"} ago`;
      },
      () => {
        const top = [...views].sort((a, b) => (b.ac.altGeom ?? b.ac.altBaro ?? 0) - (a.ac.altGeom ?? a.ac.altBaro ?? 0))[0];
        return top ? `Highest in your sky: ${(top.ac.flight || top.ac.hex).trim()} at ${n0(top.ac.altGeom ?? top.ac.altBaro ?? 0)} ft` : null;
      },
      () => (st.moonAlt > 0 ? `The Moon is ${Math.round(st.moonIllum * 100)}% lit and ${n0(Astronomy.GeoMoon(date).Length() * 149597870.7)} km away` : null),
      () => (sats.counts.up ? `${sats.counts.up} tracked satellites are above your horizon${sats.counts.shining ? `, ${sats.counts.shining} catching sunlight` : ", all in Earth's shadow"}` : null),
      () => {
        const fast = [...views].sort((a, b) => (b.ac.gs ?? 0) - (a.ac.gs ?? 0))[0];
        return fast && fast.ac.gs ? `Fastest overhead: ${(fast.ac.flight || fast.ac.hex).trim()} at ${n0(fast.ac.gs * NM_KM)} km/h` : null;
      },
      () => {
        const ev = Astronomy.SearchRiseSet(Astronomy.Body.Sun, new Astronomy.Observer(cfg.centerLat, cfg.centerLon, 1200), st.sunAlt > 0 ? -1 : 1, date, 1);
        return ev ? `${st.sunAlt > 0 ? "Sunset" : "Sunrise"} at ${ev.date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}` : null;
      },
      () => {
        const iss = sats.views.find((s) => s.iss && s.el > 0);
        return iss ? `The space station is in your sky right now, ${n0(iss.rangeKm)} km away` : null;
      },
      () => (views.length ? `${views.length} aircraft within ${n0(cfg.wallRangeNm * NM_KM)} km of you` : null),
      () => {
        const km = Math.hypot((KANGCHENJUNGA.lat - cfg.centerLat) * 111.2, (KANGCHENJUNGA.lon - cfg.centerLon) * 111.2 * Math.cos(cfg.centerLat * D2R));
        return km < 200 ? `Kangchenjunga, ${n0(KANGCHENJUNGA.m)} m, stands ${n0(km)} km to your ${compass(bearing(cfg.centerLat, cfg.centerLon, KANGCHENJUNGA.lat, KANGCHENJUNGA.lon))}` : null;
      },
      () => (meteors.seen > 1 && st.sunAlt < -12 && date.getUTCMonth() === 10 ? "Mid-November is Leonid season — watch for streaks from the east after midnight" : null),
    ];
    for (let k = 0; k < facts.length; k++) {
      let out: string | null = null;
      try {
        out = facts[(momentIdx + k) % facts.length]();
      } catch {
        out = null;
      }
      if (out) {
        momentIdx = (momentIdx + k + 1) % facts.length;
        return out;
      }
    }
    return "";
  }

  // --- frame loop ---
  let fps = 30;
  let fpsChecked = false;
  let lastOverlay = 0;
  let loreBox: Box | null = null;
  let radioBox: Box | null = null;
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
    dayNow = st.day;
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
    const dark = 1 - Math.max(0, Math.min(1, (st.sunAlt + 12) / 9));
    horizon.lampUniforms.uTime.value = tSec;
    horizon.lampUniforms.uScale.value = pixelScale;
    horizon.lampUniforms.uNight.value = Math.max(0, Math.min(1, (-st.sunAlt - 1) / 6));
    meteors.update(dt, { dark, sky, date, headingDeg: heading });
    flyers.update(dt, tSec, { day: st.day, twilight: st.twilight, headingDeg: heading, pitchDeg: pitch });
    renderer.render(scene, camera);

    // Frame rate: if this display cannot keep up, trade sharpness for motion.
    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    if (!fpsChecked && tSec - started > 25) {
      fpsChecked = true;
      if (fps < 22 && dprCap > 1) {
        dprCap = 1;
        resize();
      }
    }

    // Aircraft in the clear (not behind the hills), nearest first.
    const clear = fleet.views.filter((v) => v.el >= horizon.skylineAt(v.az)).sort((a, b) => a.rangeKm - b.rangeKm);
    const screenOf = new Map<string, { x: number; y: number }>();
    for (const v of clear) {
      const sp = toScreen(v.pos);
      if (sp) screenOf.set(v.ac.hex, sp);
    }
    for (const v of fleet.views) {
      if (known.has(v.ac.hex)) continue;
      known.add(v.ac.hex);
      if (tSec - started > 25 && arrivals.length < 3) {
        const a = v.ac;
        const who = `${a.airline ? a.airline + " " : ""}${(a.flight || a.registration || a.hex.toUpperCase()).trim()}`;
        arrivals.push(`Just came into range: ${who}${a.originName && a.destName ? `, ${a.originName} to ${a.destName}` : ""}`);
      }
    }

    // Second pass: the close-up, drawn into a square the overlay masks to a circle.
    const focus = cfg.wallScope ? pickFocus(tSec, clear, new Set(screenOf.keys())) : null;
    const scope = { R: H * 0.15, cx: W - H * 0.06 - H * 0.15, cy: H - H * 0.115 - H * 0.15 };
    lastFocus = focus;
    if (focus) lookUp(focus);
    if (tSec - lastObserve > 1) {
      lastObserve = tSec;
      if (status?.mode !== "replay") radio.observe(tSec, fleet.views, { place: cfg.wallPlaceName || "Area", windDir, windKmh, observerFt: observerKm * 3280.84 });
    }
    if (focus) {
      scopeCam.fov = Math.max(2.5, Math.min(22, focus.sizeDeg * 2.5));
      scopeCam.lookAt(focus.pos);
      scopeCam.updateProjectionMatrix();
      scopeCam.updateMatrixWorld();
      const [vx, vy, vs] = [scope.cx - scope.R, H - (scope.cy + scope.R), scope.R * 2];
      renderer.setViewport(vx, vy, vs, vs);
      renderer.setScissor(vx, vy, vs, vs);
      renderer.setScissorTest(true);
      renderer.autoClear = false;
      renderer.clearDepth();
      fleet.boost(true);
      foreground.show(false);
      renderer.render(scene, scopeCam);
      foreground.show(cfg.wallForeground);
      fleet.boost(false);
      renderer.autoClear = true;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, W, H);
    }

    // Sound: the three loudest aircraft, each placed where it is on the wall.
    const voices: Voice[] = fleet.views.map((v) => {
      const d = v.pos.length();
      const sp = screenOf.get(v.ac.hex);
      const rel = ((v.az - heading + 540) % 360) - 180;
      return {
        gain: Math.min(1, Math.pow(8 / Math.max(d, 2), 1.4)) * (sp ? 1 : 0.4) * (v.ac.hex === focusHex ? 1.4 : 1),
        pan: sp ? (sp.x / W) * 2 - 1 : rel > 0 ? 1 : -1,
        bright: Math.max(0.08, Math.min(1, 1 - d / 38)),
      };
    }).sort((a, b) => b.gain - a.gain).slice(0, 3);
    // Android pauses the page's audio when another screen (settings, an input
    // picker) comes in front, and does not restart it afterwards.
    if (cfg.wallSound && !sound.running) sound.unlock();
    sound.update(dt, tSec, { enabled: cfg.wallSound, volume: cfg.wallVolume, night: 1 - st.day, windKmh, voices });

    // ---- 2D overlay: compass, tags, info line ----
    // Text is costly on a TV chipset and nothing here moves fast: redraw at ~10 Hz.
    if (nowMs - lastOverlay < 95) return;
    lastOverlay = nowMs;
    ov.clearRect(0, 0, W, H);
    taken.length = 0;
    // Keep tags off the words: the story, the radio strip and the bottom line.
    if (loreBox) taken.push(loreBox);
    if (radioBox) taken.push(radioBox);
    if (showHud) taken.push([0, H - H * 0.05, W, H * 0.05]);
    loreBox = radioBox = null;
    const fs = Math.max(11, H * 0.0185 * (cfg.wallTextScale || 1));
    if (focus) {
      drawScope(focus, scope, (override.fov ?? cfg.wallFovDeg) / scopeCam.fov, Math.min(1, (tSec - focusSince) / 0.7), observerKm, screenOf.get(focus.ac.hex) ?? null);
    }

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
        if (focus && v.ac.hex === focus.ac.hex) {
          taken.push([p.x - H * 0.035, p.y - H * 0.035, H * 0.07, H * 0.07]);
          return; // the card speaks for this one
        }
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
          ov.font = `500 ${fs * 0.92}px ${FONT}`;
          const name = (a.flight || a.hex).trim();
          const box: Box = [p.x + H * 0.022, p.y - H * 0.016 - fs * 0.5, ov.measureText(name).width, fs];
          if (!free(box)) return;
          taken.push(box);
          ov.textBaseline = "middle";
          ov.fillStyle = `rgba(3,8,15,${0.6 + 0.25 * st.day})`;
          ov.fillRect(box[0] - fs * 0.3, box[1] - fs * 0.1, box[2] + fs * 0.6, fs * 1.2);
          ov.fillStyle = "rgba(0,0,0,0.6)";
          ov.fillText((a.flight || a.hex).trim(), p.x + H * 0.022 + 1, p.y - H * 0.016 + 1);
          ov.fillStyle = `rgba(240,246,255,${v.alpha})`;
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
      if (pk && pk.el > 1.5) {
        const bz = bearing(cfg.centerLat, cfg.centerLon, KANGCHENJUNGA.lat, KANGCHENJUNGA.lon);
        const near = Math.abs(((pk.az - bz + 540) % 360) - 180) < 4;
        const p = toScreen(dirFromAzEl(pk.az, pk.el, tmp).multiplyScalar(790));
        if (p) tag(p, near ? KANGCHENJUNGA.name : `${Math.round(pk.heightM).toLocaleString()} m`, near ? `${KANGCHENJUNGA.m.toLocaleString()} m` : "highest on the skyline", "215,225,240", 0.75, H * 0.03, false);
      }
    }

    // Replayed traffic is not "right now": no live notes or radio over it.
    if (cfg.wallMoments && status?.mode !== "replay") {
      // One unhurried line at a time: 22 s on the wall, a few seconds of quiet
      // sky between, slow fades. An arrival may cut the quiet short, never a line.
      const SHOW = 22;
      const GAP = 6;
      if (tSec - momentAt > SHOW + GAP || (arrivals.length > 0 && tSec - momentAt > SHOW + 1)) {
        moment = lore.next(
          {
            date, lat: cfg.centerLat, lon: cfg.centerLon, sunAlt: st.sunAlt, focus: lastFocus, observerKm,
            place: cfg.wallPlaceName || "this house", extra: lastFocus ? extras.get(lastFocus.ac.hex) : undefined,
          },
          () => nextMoment(date, fleet.views),
        );
        momentAt = tSec;
      }
      const age = tSec - momentAt;
      const a = Math.max(0, Math.min(1, age / 2.5, (SHOW - age) / 3));
      if (moment && a > 0) {
        const big = fs * 1.22;
        ov.font = `500 ${big}px ${FONT}`;
        const maxW = W - (H * 0.06 + Math.min(H * 0.6 * Math.max(1, (cfg.wallTextScale || 1) * 0.95), W * 0.5)) - H * 0.1;
        const lines = wrap(moment.text, maxW);
        const [x, y] = [H * 0.04, H * 0.045];
        loreBox = [x, y, maxW, fs * 1.1 + lines.length * big * 1.38];
        // A dark plate behind the words: faint at night, firm against a bright day sky.
        const textW = Math.max(...lines.map((ln) => ov.measureText(ln).width));
        ov.globalAlpha = a;
        ov.fillStyle = `rgba(3,8,15,${0.62 + 0.26 * st.day})`;
        roundRect(x - fs * 0.9, y - fs * 0.7, textW + fs * 1.8, fs * 1.1 + lines.length * big * 1.38 + fs * 1.1, H * 0.01);
        ov.fill();
        ov.textBaseline = "top";
        ov.font = `600 ${fs * 0.78}px ${FONT}`;
        ov.fillStyle = "rgba(150,205,255,0.98)";
        ov.fillText(moment.kicker, x, y);
        ov.font = `500 ${big}px ${FONT}`;
        lines.forEach((ln, k) => {
          const yy = y + fs * 1.1 + k * big * 1.38;
          ov.fillStyle = "rgba(0,0,0,0.6)";
          ov.fillText(ln, x + 1, yy + 1.5);
          ov.fillStyle = "rgba(244,247,255,1)";
          ov.fillText(ln, x, yy);
        });
        ov.globalAlpha = 1;
      }
    }

    if (cfg.wallRadio && status?.mode !== "replay") {
      if (tSec - callAt > callFor + 8) {
        const c = radio.take(tSec, focusHex, new Set(screenOf.keys()));
        if (c) {
          call = c;
          callAt = tSec;
          // A designed voice takes a few seconds to make, so the words stay up longer.
          callFor = 13 + c.lines.length * 4 + (cfg.wallSpeak && cfg.wallSound ? 7 : 0);
          if (cfg.wallSpeak && cfg.wallSound) {
            const sp = screenOf.get(c.hex);
            void sound.say(c.lines.map((l) => ({ url: sayUrl(l.speak, voiceFor(l.who, c.hex), c.channel === "radio"), pitch: 1 })), c.channel, sp ? (sp.x / W) * 2 - 1 : 0);
          }
        }
      }
      const age = tSec - callAt;
      const a = Math.max(0, Math.min(1, age / 1.2, (callFor - age) / 2.5));
      if (call && a > 0) {
        const maxW = Math.min(H * 0.95, W - H * 0.52);
        const x = H * 0.04;
        const cabin = call.channel === "cabin";
        const rgb = cabin ? "255,214,150" : "150,235,190";
        ov.font = `500 ${fs * 0.98}px ${FONT}`;
        const who = Math.max(...call.lines.map((l) => ov.measureText(l.who).width)) + fs * 0.8;
        const said = call.lines.map((l) => wrap(`\u201C${l.text}\u201D`, maxW - who));
        ov.font = `500 ${fs * 0.94}px ${FONT}`;
        const why = wrap(call.meaning, maxW);
        const hgt = fs * 1.5 + said.reduce((n, l) => n + l.length, 0) * fs * 1.34 + fs * 0.5 + why.length * fs * 1.12;
        let y = H - H * 0.075 - hgt;
        radioBox = [x - fs * 0.8, y - fs * 0.6, maxW + fs * 1.6, hgt + fs * 1.2];
        ov.globalAlpha = a * 0.94;
        ov.fillStyle = `rgba(3,8,15,${0.78 + 0.12 * st.day})`;
        roundRect(x - fs * 0.8, y - fs * 0.6, maxW + fs * 1.6, hgt + fs * 1.2, H * 0.01);
        ov.fill();
        ov.textBaseline = "top";
        ov.font = `600 ${fs * 0.76}px ${FONT}`;
        ov.fillStyle = `rgba(${rgb},0.95)`;
        ov.fillText(cabin ? "IN THE CABIN  ·  the customary words at this moment, not a recording" : "ON THE RADIO  ·  rebuilt from its movements, not a recording", x, y, maxW);
        y += fs * 1.5;
        call.lines.forEach((l, k) => {
          ov.font = `600 ${fs * 0.78}px ${FONT}`;
          ov.fillStyle = `rgba(${rgb},0.85)`;
          ov.fillText(l.who, x, y + fs * 0.22);
          ov.font = `500 ${fs * 0.98}px ${FONT}`;
          ov.fillStyle = "rgba(240,244,252,0.97)";
          for (const ln of said[k]) {
            ov.fillText(ln, x + who, y);
            y += fs * 1.34;
          }
        });
        y += fs * 0.5;
        ov.font = `500 ${fs * 0.94}px ${FONT}`;
        ov.fillStyle = "rgba(226,233,248,1)";
        for (const ln of why) {
          ov.fillText(ln, x, y);
          y += fs * 1.12;
        }
        ov.globalAlpha = 1;
      }
    }

    if (showHud) {
      const clock: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
      let time: string;
      try {
        time = date.toLocaleTimeString("en-GB", placeTz ? { ...clock, timeZone: placeTz } : clock);
      } catch {
        time = date.toLocaleTimeString("en-GB", clock);
      }
      const feed = !connected
        ? "connecting…"
        : status?.mode === "replay" && status.replayOf
          ? `REPLAY of ${new Date(status.replayOf).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · ${fleet.views.length} aircraft`
          : status && !status.ok
            ? "aircraft feed down"
            : `${fleet.views.length} aircraft`;
      const light = st.sunAlt > 0 ? "day" : st.sunAlt > -6 ? "twilight" : st.sunAlt > -18 ? "dusk" : "night";
      const line = [
        ...(cfg.wallPlaceName ? [cfg.wallPlaceName] : []),
        ...(cfg.wallPlaceName ? [] : [`${Math.abs(cfg.centerLat).toFixed(2)}°${cfg.centerLat >= 0 ? "N" : "S"} ${Math.abs(cfg.centerLon).toFixed(2)}°${cfg.centerLon >= 0 ? "E" : "W"}`]),
        time, light, feed,
        `${sats.counts.up} satellites up${sats.counts.shining ? `, ${sats.counts.shining} shining` : ""}`,
        `facing ${Math.round(heading)}°`,
        compress > 1 ? `aircraft distance ÷${compress}` : "true geometry",
        ...(showFps ? [`${Math.round(fps)} fps @${dpr}x`, sound.running ? "sound on" : "sound waiting"] : []),
      ].join("   ·   ");
      ov.font = `500 ${fs * 0.94}px ${FONT}`;
      ov.fillStyle = `rgba(3,8,15,${0.55 + 0.3 * st.day})`;
      ov.fillRect(0, H - H * 0.018 - fs * 1.35, Math.min(W, ov.measureText(line).width + H * 0.044), fs * 1.35 + H * 0.018);
      ov.textBaseline = "bottom";
      ov.fillStyle = "rgba(0,0,0,0.5)";
      ov.fillText(line, H * 0.022 + 1, H - H * 0.018 + 1);
      ov.fillStyle = "rgba(240,244,252,1)";
      ov.fillText(line, H * 0.022, H - H * 0.018);
    }
  };
  requestAnimationFrame(frame);
}

// An old TV browser fails silently; put the reason on the wall instead.
window.addEventListener("error", (e) => fail(`Sky window stopped: ${e.message}`));
start();
