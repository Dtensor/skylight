// Bundled airport geometry, drawn at true geographic position so departures and
// arrivals visibly line up with the runways. Coordinates from OurAirports (VEBD).

export interface Runway {
  leIdent: string;
  heIdent: string;
  le: [number, number]; // [lat, lon]
  he: [number, number];
  widthFt: number;
}

export interface Airport {
  icao: string;
  name: string;
  runways: Runway[];
}

// Bagdogra (IXB / VEBD), Siliguri — the nearest airport to Kalimpong (~43 mi SW).
// Single runway 18/36, 9035 ft × 150 ft. Endpoints from OurAirports.
export const BAGDOGRA: Airport = {
  icao: "VEBD",
  name: "IXB",
  runways: [
    { leIdent: "18", heIdent: "36", le: [26.6936, 88.328903], he: [26.668900, 88.328201], widthFt: 150 },
  ],
};

// Paro (PBH / VQPR), Bhutan — ~60 mi ENE of Kalimpong, inside a 150 mi field.
// One runway 15/33, 7431 ft × 98 ft, floor of a Himalayan valley at ~7300 ft.
// One of the world's most dramatic approaches. Endpoints from OurAirports.
export const PARO: Airport = {
  icao: "VQPR",
  name: "PBH",
  runways: [
    { leIdent: "15", heIdent: "33", le: [27.412162, 89.41906], he: [27.394393, 89.430371], widthFt: 98 },
  ],
};

/** Airports drawn on the map. Add more by extending this list. */
export const AIRPORTS: Airport[] = [BAGDOGRA, PARO];
