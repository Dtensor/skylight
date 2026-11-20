// Notable-aircraft alerts. Watches the LIVE sky (never replays) and raises an
// alert once per aircraft per cooldown for: an emergency squawk, a very large
// airframe (A380, 747, 777-300ER…), a military transport, and — if asked — an
// aircraft this house has never recorded before. Rare is the point in quiet
// Himalayan airspace, so each alert is worth a chime, not a stream of them.

import { notableKind, displayHex, type Aircraft, type Config, type SkyAlert } from "@shared/index.js";

const COOLDOWN_MS = 6 * 3600_000;
const KEEP = 30;

function miles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export class Alerts {
  private last = new Map<string, number>();
  private recent: SkyAlert[] = [];
  /** The first snapshot after start-up only seeds cooldowns: whatever is
   *  already in view is not news, and a restart must not chime five times. */
  private seeded = false;

  constructor(private isKnown: (lat: number, lon: number, hex: string) => boolean) {}

  list(): SkyAlert[] {
    return this.recent;
  }

  /** New alerts for this live snapshot (already de-duplicated). */
  check(now: number, aircraft: Aircraft[], cfg: Config): SkyAlert[] {
    if (!cfg.alerts) return [];
    const out: SkyAlert[] = [];
    const seeding = !this.seeded;
    this.seeded = true;
    for (const ac of aircraft) {
      if (ac.replay || ac.lat == null || ac.lon == null || ac.onGround) continue;
      // Only what the ceiling can show: the wall's 250 nm reach is too wide
      // to call anything "overhead".
      const dist = miles(cfg.centerLat, cfg.centerLon, ac.lat, ac.lon);
      if (dist > cfg.radiusMiles) continue;
      const kind = notableKind(ac.typeCode, ac.squawk);
      let alertKind: SkyAlert["kind"] | null =
        kind === "emergency" || kind === "heavy" || kind === "military" ? kind : null;
      if (!alertKind && cfg.alertStrangers && !this.isKnown(cfg.centerLat, cfg.centerLon, ac.hex)) {
        alertKind = "stranger";
      }
      if (!alertKind) continue;
      const key = `${ac.hex}:${alertKind}`;
      const prev = this.last.get(key);
      if (prev != null && now - prev < COOLDOWN_MS) continue;
      this.last.set(key, now);
      if (seeding && alertKind !== "emergency") continue; // emergencies always alert

      const type = ac.typeName ?? ac.typeCode ?? "aircraft";
      const call = ac.flight ?? ac.registration ?? displayHex(ac.hex);
      const alt = ac.altBaro ?? ac.altGeom;
      const route = ac.origin && ac.destination ? `${ac.origin} → ${ac.destination}` : "";
      const title =
        alertKind === "emergency"
          ? `Emergency squawk ${ac.squawk}`
          : alertKind === "heavy"
            ? `${type} ${dist < 15 ? "overhead" : "in view"}`
            : alertKind === "military"
              ? `Military ${type}`
              : `First sighting: ${type}`;
      const detail = [call, route, alt != null ? `${Math.round(alt).toLocaleString("en-US")} ft` : "", `${Math.round(dist)} mi away`]
        .filter(Boolean)
        .join(" · ");
      out.push({
        id: `${key}:${now}`,
        at: now,
        hex: ac.hex,
        flight: ac.flight,
        kind: alertKind,
        title,
        detail,
        chime: alertKind !== "stranger",
      });
    }
    if (out.length) this.recent = [...out, ...this.recent].slice(0, KEEP);
    // Forget cooldowns long past, so the map stays small.
    if (this.last.size > 2000) {
      for (const [k, t] of this.last) if (now - t > COOLDOWN_MS) this.last.delete(k);
    }
    return out;
  }
}
