// Recorder + replayer for quiet skies (idea from airtraffic.stream's feeds.js).
//
// Kalimpong's airspace is often empty, and free feeds blip. Rather than leave
// the ceiling black, we keep the most recent frames that actually had traffic
// and, when the sky has been quiet for a while, play them back — interpolated
// between recorded fixes and always labelled as a replay with the time it was
// recorded. Only frames this server itself observed are ever replayed.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { notableKind, type Aircraft } from "@shared/index.js";

interface Frame {
  t: number;
  aircraft: Aircraft[];
}

export interface ReplayFrame {
  aircraft: Aircraft[];
  /** When (ms epoch) the earlier of the two blended frames was recorded. */
  recordedAt: number;
}

/** Fields worth replaying; drops per-poll noise (seen, rssi, ts). */
const KEEP: (keyof Aircraft)[] = [
  "hex", "flight", "lat", "lon", "altBaro", "altGeom", "gs", "track", "baroRate",
  "squawk", "category", "onGround", "registration", "typeCode", "typeName",
  "airline", "origin", "destination", "originName", "destName",
  "originLat", "originLon", "destLat", "destLon",
];

/** Frames further apart than this are separate stretches of traffic. */
const SEGMENT_GAP_MS = 30_000;
/** Time given to the jump between stretches (and the loop wrap), so tracks
 *  from different stretches never join up on screen. */
const BREAK_MS = 3_000;

function compact(ac: Aircraft): Aircraft {
  const out: Record<string, unknown> = {};
  for (const k of KEEP) if (ac[k] !== undefined && ac[k] !== null) out[k] = ac[k];
  return out as unknown as Aircraft;
}

/** Shortest-way blend of two bearings in degrees (359° → 1° passes north). */
export function blendBearing(a: number, b: number, f: number): number {
  return (a + ((((b - a + 540) % 360) - 180) * f) + 360) % 360;
}

/** How interesting a frame is: busy skies and big or military iron score. */
export function frameScore(f: Frame): number {
  let s = f.aircraft.length;
  for (const a of f.aircraft) {
    const k = notableKind(a.typeCode, a.squawk);
    s += k === "heavy" || k === "military" || k === "emergency" ? 12 : k === "widebody" ? 4 : 0;
  }
  return s;
}

export class ReplayStore {
  private frames: Frame[] = [];
  /** Best stretches that rolled out of `frames`, kept for quiet nights. */
  private highlights: Frame[] = [];
  private lastRecord = 0;
  private dirty = false;
  // Playback state.
  private playStart = 0;
  private timeline: { pos: number[]; seg: number[]; total: number } | null = null;

  constructor(
    private path: string,
    private recordEveryMs = 3_000,
    private maxFrames = 600,
    private maxHighlights = 300,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      const valid = (list: unknown): Frame[] =>
        Array.isArray(list)
          ? list.filter((f): f is Frame => !!f && typeof f.t === "number" && Array.isArray(f.aircraft))
          : [];
      // Older files were a bare array of recent frames.
      const obj = (Array.isArray(raw) ? { recent: raw } : raw) as { recent?: unknown; highlights?: unknown };
      this.frames = valid(obj.recent).slice(-this.maxFrames);
      this.highlights = valid(obj.highlights).slice(-this.maxHighlights);
    } catch {
      this.frames = [];
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({ recent: this.frames, highlights: this.highlights }));
  }

  get size(): number {
    return this.frames.length + this.highlights.length;
  }
  get highlightCount(): number {
    return this.highlights.length;
  }

  /** Keep a live snapshot. Empty skies are not recorded, so the store always
   *  holds the most recent traffic however long the quiet lasts. */
  record(now: number, aircraft: Aircraft[]): void {
    const withPos = aircraft.filter((a) => a.lat != null && a.lon != null);
    if (!withPos.length || now - this.lastRecord < this.recordEveryMs) return;
    this.lastRecord = now;
    this.frames.push({ t: now, aircraft: withPos.map(compact) });
    if (this.frames.length > this.maxFrames) {
      const out = this.frames.splice(0, this.frames.length - this.maxFrames);
      this.keepHighlights(out);
    }
    this.timeline = null;
    this.dirty = true;
  }

  /** Frames leaving the recent window are kept if they beat the usual sky:
   *  big or military aircraft aboard, or noticeably busier than typical. */
  private keepHighlights(out: Frame[]): void {
    const counts = this.frames.map((f) => f.aircraft.length).sort((a, b) => a - b);
    const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    for (const f of out) {
      const score = frameScore(f);
      const special = score - f.aircraft.length >= 12; // a heavy, military or emergency
      const busy = f.aircraft.length >= Math.max(3, Math.ceil(median * 1.5));
      if (special || busy) this.highlights.push(f);
    }
    if (this.highlights.length > this.maxHighlights) {
      this.highlights.splice(0, this.highlights.length - this.maxHighlights);
    }
  }

  /** Playback order: highlights first (oldest first), then the recent window. */
  private get reel(): Frame[] {
    return this.highlights.length ? [...this.highlights, ...this.frames] : this.frames;
  }

  /** Begin (or restart) playback from the first recorded frame. */
  startPlayback(now: number): void {
    this.playStart = now;
    this.timeline = null;
  }

  private buildTimeline(): { pos: number[]; seg: number[]; total: number } {
    const reel = this.reel;
    const pos = [0];
    const seg = [0];
    for (let i = 1; i < reel.length; i++) {
      const dt = reel[i].t - reel[i - 1].t;
      const brk = dt > SEGMENT_GAP_MS;
      pos.push(pos[i - 1] + (brk ? BREAK_MS : dt));
      seg.push(seg[i - 1] + (brk ? 1 : 0));
    }
    return { pos, seg, total: pos[pos.length - 1] + BREAK_MS };
  }

  /** The recorded sky at this moment of playback, or null with nothing kept. */
  frameAt(now: number): ReplayFrame | null {
    const reel = this.reel;
    if (reel.length < 2) return null;
    const tl = (this.timeline ??= this.buildTimeline());
    const elapsed = Math.max(0, now - this.playStart);
    const loop = Math.floor(elapsed / tl.total);
    const p = elapsed % tl.total;
    let i = 0;
    while (i + 1 < tl.pos.length && tl.pos[i + 1] <= p) i++;
    const a = reel[i];
    const b = reel[i + 1];
    const sameSeg = !!b && tl.seg[i + 1] === tl.seg[i];
    const f = sameSeg ? (p - tl.pos[i]) / Math.max(1, tl.pos[i + 1] - tl.pos[i]) : 0;
    const later = sameSeg ? new Map(b.aircraft.map((x) => [x.hex, x])) : new Map<string, Aircraft>();
    // Each stretch and each loop gets fresh track ids, so the display fades the
    // old trail out instead of drawing a line back to where the loop began.
    const epoch = `${loop}.${tl.seg[i]}`;
    const aircraft = a.aircraft.map((p0) => {
      const q = later.get(p0.hex);
      const out: Aircraft = { ...p0, hex: `${p0.hex}~r${epoch}`, replay: true, ts: now };
      if (!q) return out;
      const lerp = (x?: number | null, y?: number | null) =>
        x == null || y == null ? x : x + (y - x) * f;
      out.lat = lerp(p0.lat, q.lat) ?? undefined;
      out.lon = lerp(p0.lon, q.lon) ?? undefined;
      // Reported values are whole feet / knots; keep blended ones that way.
      const whole = (x?: number | null) => (x == null ? x : Math.round(x));
      out.altBaro = whole(lerp(p0.altBaro, q.altBaro)) ?? p0.altBaro;
      out.altGeom = whole(lerp(p0.altGeom, q.altGeom)) ?? p0.altGeom;
      out.gs = whole(lerp(p0.gs, q.gs)) ?? undefined;
      if (p0.track != null && q.track != null) out.track = blendBearing(p0.track, q.track, f);
      return out;
    });
    return { aircraft, recordedAt: a.t };
  }
}
