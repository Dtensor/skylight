// Data acquisition: poll the active source (radio | api), normalize records
// into our Aircraft shape, enrich them, and emit snapshots. dump1090-fa and
// airplanes.live both use the readsb JSON schema, so one normalizer covers both.

import type { Aircraft, Config, DataSource } from "@shared/index.js";
import type { SourceStatus } from "@shared/index.js";
import { lookupAirline, lookupType } from "./enrich/tables.js";
import type { RouteEnricher } from "./enrich/routes.js";
import type { ReplayStore } from "./replay.js";

/** Raw readsb-style aircraft record (subset we use). */
interface RawAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  category?: string;
  r?: string;
  t?: string;
  seen?: number;
  rssi?: number;
}

function normalize(raw: RawAircraft, ts: number): Aircraft | null {
  if (!raw.hex) return null;
  const onGround = raw.alt_baro === "ground";
  return {
    hex: raw.hex,
    flight: raw.flight?.trim() || undefined,
    lat: raw.lat,
    lon: raw.lon,
    altBaro: onGround ? null : (raw.alt_baro as number | undefined) ?? null,
    altGeom: raw.alt_geom ?? null,
    gs: raw.gs,
    track: raw.track,
    baroRate: raw.baro_rate ?? null,
    squawk: raw.squawk,
    category: raw.category,
    onGround,
    registration: raw.r,
    typeCode: raw.t,
    seen: raw.seen,
    rssi: raw.rssi,
    ts,
  };
}

const NM_PER_MILE = 0.868976;

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface PollerOptions {
  source: DataSource;
  /** dump1090 aircraft.json URL (radio source). */
  radioUrl: string;
  /** Ordered re-api point templates (airplanes.live, adsb.lol, adsb.fi, …).
   *  {lat}/{lon}/{r} are filled from config. Tried in order with failover. */
  apiUrlTemplates: string[];
  pollMs: number;
  /** When source is "radio", also poll the API and merge (keeps landing
   *  aircraft alive when local ADS-B drops them). */
  supplementApi: boolean;
  /** API poll cadence when supplementing (slower, to respect rate limits). */
  apiPollMs: number;
  getConfig: () => Config;
  enricher: RouteEnricher;
  onSnapshot: (now: number, aircraft: Aircraft[]) => void;
  onStatus: (status: SourceStatus) => void;
  /** Recorder/replayer for quiet skies; omit to disable replay entirely. */
  replay?: ReplayStore;
}

/** A failed feed counts as stale (last picture held) for this long. */
const STALE_GRACE_MS = 45_000;

/**
 * Merge a primary (radio) list with a secondary (API) list by hex, preferring
 * whichever fix is fresher. Radio is biased a couple seconds so it wins while
 * it's tracking; the API takes over only once the radio fix goes stale.
 */
function mergeSources(radio: Aircraft[], api: Aircraft[]): Aircraft[] {
  const byHex = new Map<string, Aircraft>();
  for (const a of api) byHex.set(a.hex, a);
  for (const r of radio) {
    const existing = byHex.get(r.hex);
    if (!existing) {
      byHex.set(r.hex, r);
      continue;
    }
    const rSeen = (r.seen ?? 0) - 2; // bias toward the local radio
    const aSeen = existing.seen ?? 999;
    byHex.set(r.hex, rSeen <= aSeen ? r : existing);
  }
  return [...byHex.values()];
}

/** Enrichment we've resolved for an aircraft, kept sticky for its session. */
interface StickyEnrichment {
  typeName?: string;
  airline?: string;
  origin?: string;
  destination?: string;
  registration?: string;
  originName?: string;
  destName?: string;
  originLat?: number;
  originLon?: number;
  destLat?: number;
  destLon?: number;
  lastSeen: number;
}

export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private apiTimer: ReturnType<typeof setInterval> | null = null;
  private status: SourceStatus;
  private last: Aircraft[] = [];
  /** Most recent API snapshot, used to supplement the radio. */
  private lastApi: Aircraft[] = [];
  /** Index of the API endpoint that last responded — stick to it until it fails. */
  private apiIdx = 0;
  /** Host of the active API endpoint, surfaced in status messages. */
  private apiHost = "";
  /** hex -> last good enrichment, so resolved routes never flicker back to "—". */
  private sticky = new Map<string, StickyEnrichment>();
  /** Latest *live* aircraft (never replayed ones) — what memory may note. */
  private lastLive: Aircraft[] = [];
  /** When live traffic was last seen; quiet time counts from start-up. */
  private lastTraffic = Date.now();
  private replaying = false;

  constructor(private o: PollerOptions) {
    this.status = {
      source: o.source,
      ok: false,
      count: 0,
      lastOk: null,
    };
  }

  getSnapshot(): { now: number; aircraft: Aircraft[] } {
    return { now: Date.now(), aircraft: this.last };
  }
  /** Only what is really overhead now: never contains replayed traffic. */
  getLiveSnapshot(): { now: number; aircraft: Aircraft[] } {
    return { now: Date.now(), aircraft: this.replaying ? [] : this.lastLive };
  }
  getStatus(): SourceStatus {
    return this.status;
  }
  setSource(source: DataSource): void {
    this.o.source = source;
    this.status.source = source;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.pollMs);
    if (this.o.supplementApi) {
      void this.refreshApi();
      this.apiTimer = setInterval(() => void this.refreshApi(), this.o.apiPollMs);
    }
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.apiTimer) clearInterval(this.apiTimer);
    this.timer = null;
    this.apiTimer = null;
  }

  private parseList(json: any, now: number): Aircraft[] {
    const rawList: RawAircraft[] = json.aircraft ?? json.ac ?? [];
    const list: Aircraft[] = [];
    for (const raw of rawList) {
      const ac = normalize(raw, now);
      if (ac) list.push(ac);
    }
    return list;
  }

  /** Try each API endpoint in order, starting from the last good one, and
   *  return the first that responds. Null only if every endpoint fails. */
  private async fetchApi(now: number): Promise<Aircraft[] | null> {
    const templates = this.o.apiUrlTemplates;
    for (let i = 0; i < templates.length; i++) {
      const idx = (this.apiIdx + i) % templates.length;
      const url = this.buildApiUrl(templates[idx]);
      try {
        const list = this.parseList(await fetchJson(url), now);
        this.apiIdx = idx; // stick to the endpoint that worked
        try {
          this.apiHost = new URL(url).host;
        } catch {
          this.apiHost = "";
        }
        return list;
      } catch {
        // try the next endpoint in the chain
      }
    }
    return null;
  }

  private async fetchList(source: DataSource, now: number): Promise<Aircraft[] | null> {
    if (source === "api") return this.fetchApi(now);
    try {
      return this.parseList(await fetchJson(this.o.radioUrl), now);
    } catch {
      return null;
    }
  }

  private async refreshApi(): Promise<void> {
    const list = await this.fetchList("api", Date.now());
    if (list) this.lastApi = list;
  }

  private buildApiUrl(template: string): string {
    const c = this.o.getConfig();
    // The wall view looks much further out than the ceiling; fetch the wider.
    const r = Math.min(
      250,
      Math.max(Math.ceil(c.radiusMiles * NM_PER_MILE) + 1, c.wallRangeNm ?? 0),
    );
    return template
      .replace("{lat}", String(c.centerLat))
      .replace("{lon}", String(c.centerLon))
      .replace("{r}", String(r));
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const cfg = this.o.getConfig();
    const primary = await this.fetchList(this.o.source, now);
    const supplement = this.o.source === "radio" && this.o.supplementApi;
    let note: string | undefined;
    if (primary !== null) {
      const merged = supplement ? mergeSources(primary, this.lastApi) : primary;
      for (const ac of merged) this.enrich(ac, now);
      this.lastLive = merged;
      this.pruneSticky(now);
      if (merged.length) this.lastTraffic = now;
      this.o.replay?.record(now, merged);
      note = supplement
        ? `radio + ${this.lastApi.length} via ${this.apiHost || "API"}`
        : this.o.source === "api" && this.apiHost
          ? `via ${this.apiHost}`
          : undefined;
    }
    const lastOk = primary !== null ? now : this.status.lastOk;

    // Quiet = no live traffic for a while, whether the sky is empty or the
    // feed is down. Then (if allowed) replay recorded traffic, labelled.
    const quietMs = now - this.lastTraffic;
    const replay = this.o.replay;
    const wantReplay =
      cfg.replayWhenQuiet && !!replay && replay.size >= 2 &&
      quietMs > Math.max(0.5, cfg.replayAfterMin) * 60_000;
    if (wantReplay && !this.replaying) replay!.startPlayback(now);
    this.replaying = wantReplay;
    const frame = wantReplay ? replay!.frameAt(now) : null;

    if (frame) {
      this.last = frame.aircraft;
      this.status = {
        source: this.o.source,
        ok: primary !== null,
        count: frame.aircraft.length,
        lastOk,
        mode: "replay",
        replayOf: frame.recordedAt,
        message: `replay of traffic recorded ${new Date(frame.recordedAt).toISOString()}` +
          (primary === null ? " · live feed down" : " · sky quiet"),
      };
      this.o.onSnapshot(now, this.last);
      this.o.onStatus(this.status);
      return;
    }

    if (primary === null) {
      const held = lastOk != null && now - lastOk < STALE_GRACE_MS;
      this.status = {
        ...this.status,
        ok: false,
        mode: held ? "stale" : "unavailable",
        replayOf: undefined,
        message: "source fetch failed",
      };
      this.o.onStatus(this.status);
      return;
    }

    this.last = this.lastLive;
    this.status = {
      source: this.o.source,
      ok: true,
      count: this.last.length,
      lastOk: now,
      mode: "live",
      message: note,
    };
    this.o.onSnapshot(now, this.last);
    this.o.onStatus(this.status);
  }

  private enrich(ac: Aircraft, now: number): void {
    // Instant table lookups first.
    ac.typeName = lookupType(ac.typeCode);
    ac.airline = lookupAirline(ac.flight);

    // adsbdb fills gaps (route + better type), from cache when available.
    const e = this.o.enricher.enrichSync(ac.hex, ac.flight, now);
    if (e.route) {
      ac.airline = ac.airline ?? e.route.airline;
      ac.origin = e.route.origin ?? ac.origin;
      ac.destination = e.route.destination ?? ac.destination;
      ac.originName = e.route.originName ?? ac.originName;
      ac.destName = e.route.destName ?? ac.destName;
      ac.originLat = e.route.originLat ?? ac.originLat;
      ac.originLon = e.route.originLon ?? ac.originLon;
      ac.destLat = e.route.destLat ?? ac.destLat;
      ac.destLon = e.route.destLon ?? ac.destLon;
    }
    if (e.aircraft) {
      ac.typeName = ac.typeName ?? e.aircraft.typeName;
      ac.registration = ac.registration ?? e.aircraft.registration;
    }

    // Sticky merge: once we've resolved something for this hex, never drop it
    // back to undefined on a later snapshot (prevents label flicker).
    const prev = this.sticky.get(ac.hex);
    ac.typeName = ac.typeName ?? prev?.typeName;
    ac.airline = ac.airline ?? prev?.airline;
    ac.origin = ac.origin ?? prev?.origin;
    ac.destination = ac.destination ?? prev?.destination;
    ac.registration = ac.registration ?? prev?.registration;
    ac.originName = ac.originName ?? prev?.originName;
    ac.destName = ac.destName ?? prev?.destName;
    ac.originLat = ac.originLat ?? prev?.originLat;
    ac.originLon = ac.originLon ?? prev?.originLon;
    ac.destLat = ac.destLat ?? prev?.destLat;
    ac.destLon = ac.destLon ?? prev?.destLon;
    this.sticky.set(ac.hex, {
      typeName: ac.typeName,
      airline: ac.airline,
      origin: ac.origin,
      destination: ac.destination,
      registration: ac.registration,
      originName: ac.originName,
      destName: ac.destName,
      originLat: ac.originLat,
      originLon: ac.originLon,
      destLat: ac.destLat,
      destLon: ac.destLon,
      lastSeen: now,
    });
  }

  /** Drop sticky entries for aircraft long gone (keep the map small). */
  private pruneSticky(now: number): void {
    for (const [hex, s] of this.sticky) {
      if (now - s.lastSeen > 600_000) this.sticky.delete(hex);
    }
  }
}
