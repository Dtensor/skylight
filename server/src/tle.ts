// Fetches satellite TLEs (Two-Line Elements) from Celestrak, caches them in
// memory + on disk (so the appliance still has a sky if it boots offline), and
// refreshes daily. The client computes positions from these with satellite.js.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface Tle {
  name: string;
  line1: string;
  line2: string;
}

const DEFAULT_URL = [
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle",
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle",
  "https://api.wheretheiss.at/v1/satellites/25544/tles?format=text",
].join(",");

function parseTle(text: string): Tle[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length);
  const out: Tle[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith("1 ") && lines[i + 1]?.startsWith("2 ")) {
      const name = (lines[i - 1] ?? "SAT").replace(/^0 /, "").trim();
      out.push({ name, line1: lines[i], line2: lines[i + 1] });
      i++;
    }
  }
  return out;
}

export class TleStore {
  private tles: Tle[] = [];
  private fetchedAt = 0;
  private ttlMs = 24 * 3600_000;

  constructor(
    private cachePath: string,
    private url = process.env.TLE_URL ?? DEFAULT_URL,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as { at: number; tles: Tle[] };
      this.tles = parsed.tles ?? [];
      this.fetchedAt = parsed.at ?? 0;
    } catch {
      /* first run */
    }
    // Refresh on startup (non-blocking) and then on a daily timer.
    void this.refresh();
    setInterval(() => void this.refresh(), 6 * 3600_000).unref?.();
  }

  async get(): Promise<Tle[]> {
    if (Date.now() - this.fetchedAt > this.ttlMs) await this.refresh();
    return this.tles;
  }

  private async refresh(): Promise<void> {
    try {
      // TLE_URL may list several sources (comma-separated); merge them by
      // catalog number so one failing source still leaves a usable sky.
      const seen = new Set<string>();
      const tles: Tle[] = [];
      for (const url of this.url.split(",").map((u) => u.trim()).filter(Boolean)) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          for (const t of parseTle(await res.text())) {
            const id = t.line1.slice(2, 7);
            if (!seen.has(id)) {
              seen.add(id);
              tles.push(t);
            }
          }
        } catch (err) {
          console.error(`[tle] ${url}:`, err instanceof Error ? err.message : err);
        }
      }
      if (tles.length) {
        this.tles = tles;
        this.fetchedAt = Date.now();
        await mkdir(dirname(this.cachePath), { recursive: true });
        await writeFile(
          this.cachePath,
          JSON.stringify({ at: this.fetchedAt, tles }),
          "utf8",
        );
        console.log(`[tle] refreshed ${tles.length} satellites`);
      }
    } catch (err) {
      console.error("[tle] refresh failed (using cache):", err instanceof Error ? err.message : err);
    }
  }
}
