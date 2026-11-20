// Real airframe size by ICAO type code: [length, wingspan] in metres.
// Figures are the manufacturers' published dimensions (winglet / sharklet
// variants where those are the ones flying today). Used to draw each glyph
// at its true relative size: on a top-down ceiling an A380 should look
// nearly four times as wide as a CRJ-200.

const DIMS: Record<string, readonly [number, number]> = {
  // Airbus narrowbody / A220
  A318: [31.4, 34.1], A319: [33.8, 35.8], A19N: [33.8, 35.8], A320: [37.6, 35.8],
  A20N: [37.6, 35.8], A321: [44.5, 35.8], A21N: [44.5, 35.8],
  BCS1: [35.0, 35.1], BCS3: [38.7, 35.1],
  // Boeing narrowbody
  B736: [31.2, 34.3], B737: [33.6, 35.8], B738: [39.5, 35.8], B739: [42.1, 35.8],
  B37M: [35.6, 35.9], B38M: [39.5, 35.9], B39M: [42.2, 35.9], B3XM: [43.8, 35.9],
  B752: [47.3, 38.1], B753: [54.4, 38.1],
  // Widebody
  A306: [54.1, 44.8], A310: [46.7, 43.9], A332: [58.8, 60.3], A333: [63.7, 60.3],
  A338: [58.8, 64.0], A339: [63.7, 64.0], A343: [63.7, 60.3], A346: [75.3, 63.4],
  A359: [66.8, 64.8], A35K: [73.8, 64.8], A388: [72.7, 79.8],
  B762: [48.5, 47.6], B763: [54.9, 47.6], B764: [61.4, 51.9],
  B772: [63.7, 60.9], B77L: [63.7, 64.8], B773: [73.9, 60.9], B77W: [73.9, 64.8],
  B778: [70.9, 71.8], B779: [76.7, 71.8],
  B788: [56.7, 60.1], B789: [62.8, 60.1], B78X: [68.3, 60.1],
  B744: [70.7, 64.4], B748: [76.3, 68.4], MD11: [61.2, 51.7],
  // Regional jets
  E170: [29.9, 26.0], E75L: [31.7, 28.7], E75S: [31.7, 26.0], E190: [36.2, 28.7],
  E195: [38.7, 28.7], E290: [36.2, 33.7], E295: [41.5, 35.1],
  CRJ2: [26.8, 21.2], CRJ7: [32.3, 23.2], CRJ9: [36.2, 24.9], CRJX: [39.1, 26.2],
  // Turboprops
  AT43: [22.7, 24.6], AT45: [22.7, 24.6], AT46: [22.7, 24.6], AT72: [27.2, 27.1],
  AT75: [27.2, 27.1], AT76: [27.2, 27.1], DH8C: [25.7, 27.4], DH8D: [32.8, 28.4],
  DHC6: [15.8, 19.8], B190: [17.6, 17.7], B350: [14.2, 17.7], PC12: [14.4, 16.3],
  C208: [11.5, 15.9], D228: [16.6, 17.0],
  // Military transports common over the eastern Himalaya
  C130: [29.8, 40.4], C30J: [34.7, 40.4], C17: [53.0, 51.8], IL76: [46.6, 50.5],
  AN12: [33.1, 38.0], AN32: [23.8, 29.2], A400: [45.1, 42.4],
  // Business jets
  GLF5: [29.4, 28.5], GLF6: [30.4, 30.4], GLEX: [30.3, 28.7], GL7T: [33.8, 31.7],
  CL60: [20.9, 19.6], C56X: [16.0, 17.2], C68A: [19.4, 22.0], FA7X: [23.2, 26.2],
  FA8X: [24.5, 26.3], LJ45: [17.7, 14.6], E55P: [15.6, 16.2],
  // Light
  C152: [7.3, 10.1], C172: [8.3, 11.0], C182: [8.8, 11.0], SR22: [7.9, 11.7],
  PA28: [7.3, 10.7], P28A: [7.3, 10.7], DA40: [8.0, 11.9], DA42: [8.6, 13.4],
};

/** Span of the reference airliner (A320 family) — scale 1.0. */
export const REFERENCE_SPAN_M = 35.8;

export function airframeDims(typeCode?: string): { lengthM: number; spanM: number } | null {
  const d = typeCode ? DIMS[typeCode.toUpperCase()] : undefined;
  return d ? { lengthM: d[0], spanM: d[1] } : null;
}

/** Glyph scale relative to an A320, clamped so tiny GA stays visible and
 *  an A380 does not swallow the ceiling. Null when the type is unknown. */
export function trueScaleFactor(typeCode?: string): number | null {
  const d = airframeDims(typeCode);
  if (!d) return null;
  return Math.min(2.3, Math.max(0.42, d.spanM / REFERENCE_SPAN_M));
}

// --- what makes an aircraft worth a second look over the eastern Himalaya ---

// Four-engine giants only: 777-300ERs are routine long-haul traffic here
// (four of them in one evening's first snapshot), so they stay "widebody".
const HEAVY = new Set(["A388", "B744", "B748", "B74S", "B742", "A124", "A225", "A342", "A343", "A345", "A346"]);
const MILITARY = new Set([
  "C17", "IL76", "IL78", "C130", "C30J", "A400", "AN12", "AN26", "AN32", "P8",
  "K35R", "KC10", "E3TF", "AJET", "SU30", "MG29", "TEJAS", "HAWK", "C295", "IL62",
]);
const WIDE = new Set([
  "B77W", "B779", "A306", "A310", "A332", "A333", "A338", "A339", "A359", "A35K", "B762", "B763",
  "B764", "B772", "B77L", "B773", "B778", "B788", "B789", "B78X", "MD11",
]);

export type NotableKind = "emergency" | "heavy" | "military" | "widebody";

/** Emergency squawk first, then very large or military airframes. */
export function notableKind(typeCode?: string, squawk?: string): NotableKind | null {
  if (squawk === "7500" || squawk === "7600" || squawk === "7700") return "emergency";
  const t = typeCode?.toUpperCase();
  if (!t) return null;
  if (HEAVY.has(t)) return "heavy";
  if (MILITARY.has(t)) return "military";
  if (WIDE.has(t)) return "widebody";
  return null;
}
