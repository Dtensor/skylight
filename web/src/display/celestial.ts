// Compute the sky at a given instant + location: sun, moon (with phase), bright
// stars, and satellites/ISS. Everything is reduced to horizontal coordinates
// (azimuth from North, altitude above horizon) so the renderer can place them on
// the same circular "looking up" field as the aircraft.

import * as Astronomy from "astronomy-engine";
import * as satellite from "satellite.js";
import { STARS } from "./stars.js";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export type SkyKind = "sun" | "moon" | "star" | "satellite" | "iss";

export interface SkyBody {
  kind: SkyKind;
  name?: string;
  id?: string;
  az: number; // degrees from North, clockwise
  alt: number; // degrees above horizon
  mag?: number;
  illum?: number; // moon lit fraction 0..1
  waning?: boolean;
}

export interface Tle {
  name: string;
  line1: string;
  line2: string;
}

export interface Sky {
  sun?: SkyBody;
  moon?: SkyBody;
  stars: SkyBody[];
  sats: SkyBody[];
}

export interface SkyOpts {
  sun: boolean;
  moon: boolean;
  stars: boolean;
  satellites: boolean;
  magLimit: number;
  tles: Tle[];
}

function norm360(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** Horizontal coords of a fixed star from its RA/Dec and the local sidereal time. */
function starAltAz(raDeg: number, decDeg: number, lstHours: number, latDeg: number) {
  const ra = raDeg * D2R;
  const dec = decDeg * D2R;
  const lat = latDeg * D2R;
  const H = (lstHours * 15) * D2R - ra; // hour angle (rad)
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat));
  const sinAz = (-Math.sin(H) * Math.cos(dec)) / Math.cos(alt);
  const az = norm360(Math.atan2(sinAz, cosAz) * R2D);
  return { az, alt: alt * R2D };
}

function bodyAltAz(
  body: Astronomy.Body,
  date: Date,
  observer: Astronomy.Observer,
): { az: number; alt: number } {
  const eq = Astronomy.Equator(body, date, observer, true, true);
  const hor = Astronomy.Horizon(date, observer, eq.ra, eq.dec, "normal");
  return { az: hor.azimuth, alt: hor.altitude };
}

const satrecCache = new Map<string, satellite.SatRec>();
function getSatrec(tle: Tle): satellite.SatRec | null {
  const key = tle.line1 + tle.line2;
  let rec = satrecCache.get(key);
  if (!rec) {
    try {
      rec = satellite.twoline2satrec(tle.line1, tle.line2);
    } catch {
      return null;
    }
    satrecCache.set(key, rec);
  }
  return rec;
}

export function computeSky(date: Date, latDeg: number, lonDeg: number, o: SkyOpts): Sky {
  const observer = new Astronomy.Observer(latDeg, lonDeg, 0);
  const sky: Sky = { stars: [], sats: [] };

  if (o.sun) {
    const { az, alt } = bodyAltAz(Astronomy.Body.Sun, date, observer);
    sky.sun = { kind: "sun", az, alt };
  }
  if (o.moon) {
    const { az, alt } = bodyAltAz(Astronomy.Body.Moon, date, observer);
    const illum = Astronomy.Illumination(Astronomy.Body.Moon, date);
    const phase = Astronomy.MoonPhase(date); // 0..360, 180 = full
    sky.moon = { kind: "moon", az, alt, illum: illum.phase_fraction, waning: phase > 180 };
  }
  if (o.stars) {
    const lst = Astronomy.SiderealTime(date) + lonDeg / 15; // local sidereal hours
    for (const s of STARS) {
      if (s.mag > o.magLimit) continue;
      const { az, alt } = starAltAz(s.ra, s.dec, lst, latDeg);
      if (alt < -2) continue; // below horizon
      sky.stars.push({ kind: "star", id: s.id, name: s.name, az, alt, mag: s.mag });
    }
  }
  if (o.satellites && o.tles.length) {
    const gmst = satellite.gstime(date);
    const observerGd = {
      longitude: lonDeg * D2R,
      latitude: latDeg * D2R,
      height: 0,
    };
    for (const tle of o.tles) {
      const rec = getSatrec(tle);
      if (!rec) continue;
      const pv = satellite.propagate(rec, date);
      const pos = pv?.position;
      if (!pos || typeof pos === "boolean") continue;
      const ecf = satellite.eciToEcf(pos, gmst);
      const look = satellite.ecfToLookAngles(observerGd, ecf);
      const alt = look.elevation * R2D;
      if (alt < 0) continue; // below horizon
      const isISS = /ISS|ZARYA/i.test(tle.name);
      sky.sats.push({
        kind: isISS ? "iss" : "satellite",
        name: tle.name.replace(/\s*\(.*\)\s*$/, "").trim(),
        az: norm360(look.azimuth * R2D),
        alt,
      });
    }
  }
  return sky;
}

/** A forthcoming ISS pass, with how high and how long it gets. */
export interface IssPass {
  /** Timestamp (ms) when the ISS rises above `minAlt`. */
  rise: number;
  /** Peak elevation during the pass, degrees (a 70°+ pass is brilliant; ~10° grazes). */
  peakAlt: number;
  /** Minutes the ISS stays above `minAlt`. */
  durationMin: number;
}

/**
 * Find the next ISS pass and characterize it: when it rises above `minAlt`,
 * its peak elevation, and its duration. Scans forward in 30 s steps, then keeps
 * scanning through the pass to capture the peak and the set time.
 */
export function nextISSPassInfo(
  fromMs: number,
  latDeg: number,
  lonDeg: number,
  tles: Tle[],
  minAlt = 10,
  horizonHours = 12,
): IssPass | null {
  const iss = tles.find((t) => /ISS|ZARYA/i.test(t.name));
  if (!iss) return null;
  const rec = getSatrec(iss);
  if (!rec) return null;
  const observerGd = { longitude: lonDeg * D2R, latitude: latDeg * D2R, height: 0 };
  const stepMs = 30_000;
  const end = fromMs + horizonHours * 3600_000;
  let rise: number | null = null;
  let peakAlt = -90;
  for (let t = fromMs + stepMs; t < end; t += stepMs) {
    const date = new Date(t);
    const pv = satellite.propagate(rec, date);
    const pos = pv?.position;
    if (!pos || typeof pos === "boolean") {
      if (rise !== null) break;
      continue;
    }
    const ecf = satellite.eciToEcf(pos, satellite.gstime(date));
    const alt = satellite.ecfToLookAngles(observerGd, ecf).elevation * R2D;
    if (alt >= minAlt) {
      if (rise === null) rise = t;
      if (alt > peakAlt) peakAlt = alt;
    } else if (rise !== null) {
      return { rise, peakAlt: Math.round(peakAlt), durationMin: Math.round((t - rise) / 60000) };
    }
  }
  if (rise !== null) {
    return { rise, peakAlt: Math.round(peakAlt), durationMin: Math.round((end - rise) / 60000) };
  }
  return null;
}

/** Find the next time the ISS rises above `minAlt` degrees, scanning forward. */
export function nextISSPass(
  fromMs: number,
  latDeg: number,
  lonDeg: number,
  tles: Tle[],
  minAlt = 10,
  horizonHours = 12,
): number | null {
  return nextISSPassInfo(fromMs, latDeg, lonDeg, tles, minAlt, horizonHours)?.rise ?? null;
}
