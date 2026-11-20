// "→ IXB in 12 min" / "IXB departure · 34 mi out" for the airports drawn on
// the map. Times are straight-line distance over ground speed: honest for
// the last stretch of an approach, optimistic further out (no holding,
// no vectors), so long ones are shown as "~".

import type { Aircraft } from "@shared/index.js";
import type { Airport } from "../display/airports.js";

const R_MI = 3958.8;
const D2R = Math.PI / 180;

export function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(a));
}

function centre(ap: Airport): [number, number] {
  const r = ap.runways[0];
  return [(r.le[0] + r.he[0]) / 2, (r.le[1] + r.he[1]) / 2];
}

/** Does a route code (IATA "IXB" or ICAO "VEBD") name this airport? */
function names(ap: Airport, code?: string): boolean {
  if (!code) return false;
  const c = code.toUpperCase();
  return c === ap.name.toUpperCase() || c === ap.icao.toUpperCase();
}

export interface AirportEta {
  airport: string;
  kind: "arriving" | "departed";
  miles: number;
  minutes: number | null;
  text: string;
}

export function airportEta(ac: Aircraft, airports: Airport[]): AirportEta | null {
  if (ac.lat == null || ac.lon == null || ac.onGround) return null;
  for (const ap of airports) {
    const [lat, lon] = centre(ap);
    const mi = milesBetween(ac.lat, ac.lon, lat, lon);
    if (names(ap, ac.destination)) {
      const kt = ac.gs ?? 0;
      const min = kt > 60 ? Math.max(1, Math.round((mi / (kt * 1.15078)) * 60)) : null;
      const text = min == null
        ? `→ ${ap.name} · ${Math.round(mi)} mi`
        : `→ ${ap.name} in ${min > 25 ? "~" : ""}${min} min`;
      return { airport: ap.name, kind: "arriving", miles: mi, minutes: min, text };
    }
    if (names(ap, ac.origin)) {
      return { airport: ap.name, kind: "departed", miles: mi, minutes: null, text: `${ap.name} departure · ${Math.round(mi)} mi out` };
    }
  }
  return null;
}
