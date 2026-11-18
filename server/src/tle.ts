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
  // Second supplier for when CelesTrak is unreachable (it blocks callers who
  // ask too often): the large, bright objects a naked eye actually picks out —
  // spent rocket stages, the Chinese station, Hubble.
  ...["SL-16 R/B", "SL-8 R/B", "SL-14 R/B", "CZ-4", "CZ-2C R/B", "H-2A R/B", "CSS", "HST"].map(
    (q) => `https://tle.ivanstanojevic.me/api/tle/?page-size=100&search=${encodeURIComponent(q)}`,
  ),
].join(",");

function parseTle(text: string): Tle[] {
  // JSON suppliers answer { member: [{ name, line1, line2 }] }.
  if (text.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(text) as { member?: { name?: string; line1?: string; line2?: string }[] };
      return (j.member ?? [])
        .filter((m) => typeof m.line1 === "string" && typeof m.line2 === "string" && m.line1.startsWith("1 ") && m.line2.startsWith("2 "))
        .map((m) => ({ name: String(m.name ?? "SAT").trim(), line1: m.line1!, line2: m.line2! }));
    } catch {
      return [];
    }
  }
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
    // Not on every restart: CelesTrak blocks callers that ask too often.
    if (Date.now() - this.fetchedAt > 2 * 3600_000 || this.tles.length < 20) void this.refresh();
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
        // A partial answer (one source refusing, as CelesTrak does when asked
        // too often) must never shrink the sky: keep what the fresh set lacks.
        // Element sets stay usable for days.
        for (const old of this.tles) {
          const id = old.line1.slice(2, 7);
          if (!seen.has(id)) {
            seen.add(id);
            tles.push(old);
          }
        }
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
