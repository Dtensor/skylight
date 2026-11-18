// The sky's own memory: which aircraft and which flights have been seen from
// each place, on how many days, and what they were doing last time. Nothing
// here comes from outside — it is only what this house has itself observed,
// which is what makes it personal. Grows from the day it is switched on.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Aircraft } from "@shared/index.js";

interface CraftRec {
  first: string;
  last: string;
  days: number;
  reg?: string;
  flight?: string;
  route?: string;
  /** What it was doing on the previous day it was seen. */
  prev?: { date: string; flight?: string; route?: string };
}
interface FlightRec {
  days: number;
  last: string;
  /** Minute of the day it first appeared, most recent 30 days. */
  mins: number[];
}
interface Place {
  craft: Record<string, CraftRec>;
  flights: Record<string, FlightRec>;
}

export class Memory {
  private places: Record<string, Place> = {};
  private dirty = false;

  constructor(private path: string) {}

  async load(): Promise<void> {
    try {
      this.places = JSON.parse(await readFile(this.path, "utf8")) as Record<string, Place>;
    } catch {
      /* first night */
    }
    setInterval(() => void this.save(), 5 * 60_000).unref?.();
  }

  private place(lat: number, lon: number): Place {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    return (this.places[key] ??= { craft: {}, flights: {} });
  }

  note(lat: number, lon: number, list: Aircraft[], now = new Date()): void {
    const p = this.place(lat, lon);
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const minute = now.getHours() * 60 + now.getMinutes();
    for (const a of list) {
      if (a.lat == null || a.onGround) continue;
      const flight = a.flight?.trim() || undefined;
      const route = a.originName && a.destName ? `${a.originName} to ${a.destName}` : undefined;
      const c = (p.craft[a.hex] ??= { first: day, last: "", days: 0 });
      if (c.last !== day) {
        if (c.last) c.prev = { date: c.last, flight: c.flight, route: c.route };
        c.last = day;
        c.days++;
        this.dirty = true;
      }
      c.reg = a.registration ?? c.reg;
      c.flight = flight ?? c.flight;
      c.route = route ?? c.route;
      if (flight) {
        const f = (p.flights[flight] ??= { days: 0, last: "", mins: [] });
        if (f.last !== day) {
          f.last = day;
          f.days++;
          f.mins = [...f.mins, minute].slice(-30);
          this.dirty = true;
        }
      }
    }
  }

  get(lat: number, lon: number, hex: string, flight: string) {
    const p = this.place(lat, lon);
    const f = p.flights[flight];
    // "Usual time" excludes today's own entry, so tonight can be compared with it.
    const past = f ? f.mins.slice(0, -1).sort((a, b) => a - b) : [];
    return {
      craft: p.craft[hex] ?? null,
      flight: f ? { days: f.days, usualMin: past.length >= 2 ? past[Math.floor(past.length / 2)] : null, todayMin: f.mins[f.mins.length - 1] } : null,
      aircraftKnown: Object.keys(p.craft).length,
    };
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(this.places), "utf8");
    } catch (err) {
      console.error("[memory] save failed:", err instanceof Error ? err.message : err);
    }
  }
}
