// The journey: small true things to read while the sky drifts past. Some are
// about the aircraft in the close-up (its type, airline, airports, and figures
// worked out from its live position), some about flying, the season, the sky
// and the wider world. One at a time, slowly, never repeating until the well
// runs dry. Figures are rounded and worded as approximate where they are.

import type { CraftView } from "./aircraft.js";
import { SEATS, seatScene } from "./seats.js";
import { displayHex } from "@shared/index.js";

/** Conditions at a point on Earth (server /api/point, from open-meteo). */
export interface Point {
  temperature_2m?: number;
  weather_code?: number;
  wind_speed_250hPa?: number;
  wind_direction_250hPa?: number;
  timezone?: string;
}
/** What this house has itself seen of an aircraft and a flight (server /api/seen). */
export interface Seen {
  craft: { first: string; days: number; reg?: string; prev?: { date: string; flight?: string; route?: string } } | null;
  flight: { days: number; usualMin: number | null; todayMin: number } | null;
  aircraftKnown: number;
}
export interface Extra {
  seen?: Seen | null;
  dest?: Point | null;
  aloft?: Point | null;
}

export interface LoreCtx {
  date: Date;
  lat: number;
  lon: number;
  sunAlt: number;
  focus: CraftView | null;
  /** Kilometres of the observer's ground height. */
  observerKm: number;
  /** Name of the place we are lying in. */
  place: string;
  /** Looked-up facts about the aircraft in the close-up, when they have arrived. */
  extra?: Extra;
}

export interface LoreLine {
  kicker: string;
  text: string;
}

type Fn = (c: LoreCtx) => string | null;
interface Item {
  id: string;
  k: string;
  t: string | Fn;
  /** Months (1-12) in which this is worth saying; any month if absent. */
  m?: number[];
}

const n0 = (v: number): string => Math.round(v).toLocaleString("en-US");
const D2R = Math.PI / 180;

function gcKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = Math.sin(((lat2 - lat1) * D2R) / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(((lon2 - lon1) * D2R) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// ---- about the aircraft type ----
const TYPES: [RegExp, string, number, string[]][] = [
  [/^A35/, "Airbus A350", 315, [
    "More than half of an A350's structure is carbon-fibre composite rather than metal, which is why its wings can curve upward so gracefully in flight.",
    "The A350 keeps its cabin at the pressure of about 1,800 m — lower and gentler than older jets — so people step off a little less tired.",
    "An A350's wingtips sweep up and back like a bird's primary feathers; the shape was studied from soaring birds to cut the drag of wingtip vortices.",
  ]],
  [/^B78/, "Boeing 787", 290, [
    "The 787's windows have no shades. A gel between the panes darkens when a small voltage is applied, so the crew can dim a whole cabin to dusk at once.",
    "About half of a 787 by weight is carbon-fibre composite. Its fuselage is wound in one-piece barrels instead of being riveted from aluminium sheets.",
    "Look for the zig-zag edge at the back of a 787's engines. Those chevrons mix hot and cold air more smoothly, and make it quieter for people on the ground.",
  ]],
  [/^A2[01]N/, "Airbus A320neo family", 190, [
    "\"neo\" stands for new engine option. Larger, slower-turning fans let this aircraft burn roughly 15 to 20 percent less fuel than the generation before it.",
    "The upturned fins at this aircraft's wingtips are about 2.4 m tall. They weaken the swirl of air spilling round the tip, which saves fuel on every flight.",
    "The A320 was the first airliner flown by side-stick and computer rather than cables to a control column. That was in 1987; nearly every airliner since has followed.",
  ]],
  [/^A3[12][0189]/, "Airbus A320 family", 170, [
    "The A320 family is among the most-built airliners ever. On average one takes off or lands somewhere in the world every couple of seconds.",
    "The A320 was the first airliner flown by side-stick and computer rather than cables to a control column. That was in 1987; nearly every airliner since has followed.",
  ]],
  [/^B3[89]M/, "Boeing 737 MAX", 180, [
    "The 737 first flew in 1967. The aircraft above is a distant descendant: same fuselage width, but wings, engines and cockpit from a different century.",
    "The split wingtips on a 737 MAX point both up and down. Each little surface recovers some of the energy lost in the vortex trailing from the wing.",
  ]],
  [/^B73/, "Boeing 737", 170, [
    "The 737 sits so low to the ground that its engine intakes are slightly flattened underneath — a shape people call the hamster pouch.",
    "The 737 first flew in 1967 and has been in production ever since, longer than any other jet airliner.",
  ]],
  [/^B77/, "Boeing 777", 350, [
    "The engines on a long-range 777 are among the most powerful ever fitted to an airliner. Each fan is more than three metres across.",
    "The 777 was the first airliner designed entirely on computers, with no full-size mock-up built first. It entered service in 1995.",
    "Each main landing-gear leg of a 777 carries six wheels. On the ground it steers its rearmost pair to get round tight corners.",
  ]],
  [/^A33/, "Airbus A330", 280, [
    "The A330 has flown since 1992. Twin-engine jets like it quietly ended the age when crossing an ocean required three or four engines.",
    "An A330's wing spans about 60 m — wider than the Wright brothers' entire first flight was long.",
  ]],
  [/^A38/, "Airbus A380", 500, [
    "The A380 is the largest passenger aircraft ever built: two full decks, a wingspan of nearly 80 m, and room for more than 500 people.",
    "An A380 has about 500 km of wiring inside it, and its tail fin alone is as tall as a five-storey building.",
  ]],
  [/^B74/, "Boeing 747", 400, [
    "The 747's hump exists because it was designed to carry freight too: the cockpit sits upstairs so the nose can hinge open for cargo.",
    "The first 747 flew in 1969, the same year people first walked on the Moon.",
  ]],
  [/^AT[4-7]/, "ATR turboprop", 72, [
    "This is a turboprop: a jet engine turning a propeller. On short hops it burns far less fuel than a jet, which is why it serves so many hill and island towns.",
    "An ATR's wing sits on top of the fuselage, so every window seat gets a clear view of the ground — and of the six-bladed propellers.",
    "Turboprops cruise lower and slower than jets, around 500 km/h and often below 7,000 m. From the ground you see them for longer.",
  ]],
  [/^DH8/, "Dash 8", 78, [
    "The Q in Dash 8 Q400 stands for quiet. Microphones in the cabin feed a system that cancels propeller drone with opposing vibrations.",
  ]],
  [/^E(17|19|29)/, "Embraer E-Jet", 100, [
    "Embraer builds these jets in Brazil. With two seats each side of the aisle, nobody on board has a middle seat.",
  ]],
];

// ---- about the airline (ICAO callsign prefix) ----
const AIRLINES: Record<string, string[]> = {
  IGO: [
    "IndiGo carries more passengers than any other airline in India and is one of the largest operators of the Airbus A320 family anywhere.",
    "IndiGo began flying in 2006 with a single aircraft. It now makes well over two thousand flights a day.",
  ],
  AIC: [
    "Air India began in 1932 as Tata Airlines. J.R.D. Tata himself flew the first service, carrying mail from Karachi to Bombay in a single-engine Puss Moth.",
    "In 2022 Air India returned to the Tata Group, the family that founded it ninety years earlier.",
  ],
  AXB: ["Air India Express grew up connecting Kerala with the Gulf, carrying workers home and back again."],
  AKJ: ["Akasa Air is one of India's youngest airlines; its first flight was in August 2022. Akasa means sky."],
  SEJ: ["SpiceJet names each of its aircraft after a spice — there have been a Cardamom, a Saffron and a Coriander."],
  THA: ["Thai Airways paints its aircraft in purple, gold and magenta, colours taken from Thai silk and orchids."],
  CPA: ["Cathay Pacific was founded in Hong Kong in 1946 by two former wartime pilots with a single DC-3 named Betsy."],
  UAE: ["Emirates flies more A380s than every other airline combined, almost all of them through one airport in the desert."],
  QTR: ["Qatar Airways' emblem is an oryx, the long-horned antelope of the Arabian desert."],
  SIA: ["Singapore Airlines flies some of the longest passenger flights in the world: Singapore to New York, around eighteen hours without landing."],
  DRK: ["Druk Air is Bhutan's national airline. Its home airport, Paro, lies in a deep valley, and only a small number of pilots are certified to land there."],
  BTN: ["Bhutan Airlines flies into Paro, where the approach winds between mountainsides and is flown by eye, in daylight only."],
  RNA: ["Nepal Airlines has flown since 1958. Its emblem is Akash Bhairab, a guardian deity of the sky."],
  BHA: ["Buddha Air is known for its dawn mountain flights out of Kathmandu, an hour along the Himalaya to look at Everest and back."],
  BBC: ["Biman Bangladesh's emblem is a white stork — a balaka — inside a red circle."],
  EVA: ["EVA Air is Taiwanese. For years it has flown jets painted nose to tail with Hello Kitty and her friends."],
  CAL: ["China Airlines is Taiwan's flag carrier. The flower on its tail is a plum blossom, which blooms in the cold."],
  CSN: ["China Southern is based in Guangzhou. The red flower on its blue tail is the kapok, the city's emblem."],
  CES: ["China Eastern is based in Shanghai; the bird on its tail is a swallow."],
  HVN: ["Vietnam Airlines carries a golden lotus on its tail, the national flower of Vietnam."],
  KLM: ["KLM has flown since 1919, and is the oldest airline still operating under its original name."],
  BAW: ["British Airways flights are called Speedbird on the radio, after the emblem of its 1930s ancestor Imperial Airways."],
  DLH: ["The bird on a Lufthansa tail is a crane, drawn in 1918 and hardly changed since."],
  THY: ["Turkish Airlines flies to more countries than any other airline."],
  FDX: ["While passengers sleep, freight moves. FedEx's nightly sort at Memphis handles hundreds of thousands of packages in a few hours."],
  MAS: ["The emblem on a Malaysia Airlines tail is a wau bulan, a traditional moon-kite from Kelantan."],
  KAL: ["Korean Air's emblem is the taegeuk, the red-and-blue circle from the Korean flag, drawn as a propeller in motion."],
  ANA: ["All Nippon Airways began in 1952 flying helicopters. Its airline code is still NH, for Nippon Helicopter."],
  SVA: ["Saudia's fleet thins and swells with the calendar: during the Hajj it carries pilgrims from across the world to Jeddah and Medina."],
  ETD: ["Etihad means union, for the union of the seven emirates."],
};

// ---- about the places at each end (IATA) ----
const AIRPORTS: Record<string, string[]> = {
  DEL: [
    "Delhi's airport is India's busiest. In winter its runways are equipped so that aircraft can land in fog with as little as 50 m of visibility.",
    "From mid-December, fog season begins over the plains of north India. Pilots flying to Delhi train specially to land without seeing the runway until the last seconds.",
  ],
  BOM: ["Mumbai's two runways cross each other, so in practice only one is used at a time. It is among the busiest single-runway airports in the world."],
  CCU: ["Kolkata's airport was once called Dum Dum. In the 1930s it was a refuelling stop on the first air routes between Europe and Australia."],
  KTM: ["Kathmandu's airport sits in a bowl of hills at about 1,340 m. Arriving aircraft descend steeply over the valley rim to reach it."],
  PBH: ["Paro, in Bhutan, is flown into only by daylight and only by sight. The final turn passes close enough to hillside houses to see their prayer flags."],
  IXB: ["Bagdogra is the doorway to Darjeeling, Kalimpong and Sikkim. It is an air force base first; the airliners are its guests."],
  GAU: ["Guwahati is the hub for India's north-east. Its airport is named after Gopinath Bordoloi, Assam's first chief minister."],
  BKK: ["Bangkok's airport is called Suvarnabhumi, the Land of Gold — an old name for the lands east of India in Sanskrit and Pali texts."],
  HKG: ["Hong Kong's airport stands on an island that was flattened and enlarged for it. It replaced Kai Tak, where jets once turned low between apartment blocks."],
  SIN: ["Singapore's Changi airport has a forest and a forty-metre indoor waterfall, fed by rain collected from its roof."],
  DXB: ["Dubai handles more international passengers than any other airport. Most never leave the terminal; they are changing planes between continents."],
  DOH: ["Doha's airport lies partly on land reclaimed from the Gulf. Like Dubai, it lives on connecting East and West in the middle of the night."],
  TPE: ["Taipei is a great night crossroads: flights from Europe and America arrive before dawn so their passengers can connect onward across Asia."],
  LHR: ["London Heathrow began as a row of tents in 1946. Flights to it from India chase the night westward and land in the grey of early morning."],
  FCO: ["Rome's main airport is named for Leonardo da Vinci, who filled notebooks with flying machines four centuries before one worked."],
  CAN: ["Guangzhou has been a trading port for two thousand years. Its airport is now one of the busiest on Earth."],
  KMG: ["Kunming sits at about 1,900 m. In the 1940s, pilots flew supplies to it from Assam over the Himalaya — a route they called the Hump."],
  DAC: ["Dhaka lies in the delta of the Ganga and Brahmaputra; from the air the land around it is more river than ground."],
  MAA: ["Chennai was the site of some of India's very first flights: an aircraft was built and flown there in 1910."],
  BLR: ["Bengaluru's newer terminal is built as a garden, with hanging plants and bamboo, to match the city's old name: the garden city."],
  KUL: ["Kuala Lumpur's airport was planned inside a planted rainforest, with a patch of real jungle kept at the centre of its satellite terminal."],
  IST: ["Istanbul sits where Europe and Asia meet. From here an aircraft can reach more than a hundred countries without refuelling."],
  CDG: ["Paris Charles de Gaulle's first terminal is a concrete ring with glass tubes crossing its hollow centre — 1974's idea of the future."],
  SHJ: ["Sharjah was the first airport on the Arabian coast of the Gulf, a rest stop built in 1932 for flying boats and biplanes on the way to India."],
  HAN: ["Hanoi's airport, Noi Bai, lies north of the Red River. Many flights from here follow the old overland trade routes west toward India."],
  DMK: ["Don Mueang in Bangkok has been in use since 1914, which makes it one of the oldest working airports in the world."],
};

// ---- worked out from where the aircraft is right now ----
const CALC: [string, (c: LoreCtx, v: CraftView) => string | null][] = [
  ["cold", (_c, v) => {
    const ft = v.ac.altGeom ?? v.ac.altBaro ?? 0;
    if (ft < 15000) return null;
    const t = Math.max(-56.5, 15 - 1.98 * (ft / 1000));
    return `Outside this aircraft's windows it is about ${Math.round(t)} °C, and the air is too thin to breathe. Inside, people are asleep under thin blankets.`;
  }],
  ["horizon", (_c, v) => {
    const m = (v.ac.altGeom ?? v.ac.altBaro ?? 0) * 0.3048;
    return m > 6000 ? `From ${n0(Math.round(m / 100) * 100)} m, the pilots of this aircraft can see about ${n0(Math.round((3.57 * Math.sqrt(m)) / 10) * 10)} km to the horizon in every direction.` : null;
  }],
  ["everest", (_c, v) => {
    const m = (v.ac.altGeom ?? v.ac.altBaro ?? 0) * 0.3048;
    return m > 9600 ? `This aircraft is flying about ${n0(Math.round((m - 8849) / 100) * 100)} m higher than the summit of Everest.` : null;
  }],
  ["pace", (_c, v) => {
    const kmh = (v.ac.gs ?? 0) * 1.852;
    return kmh > 400 ? `This aircraft covers a kilometre about every ${(3600 / kmh).toFixed(1)} seconds — yet from here it seems to drift.` : null;
  }],
  ["route", (_c, v) => {
    const a = v.ac;
    if (a.originLat == null || a.originLon == null || a.destLat == null || a.destLon == null || a.lat == null || a.lon == null) return null;
    const total = gcKm(a.originLat, a.originLon, a.destLat, a.destLon);
    const left = gcKm(a.lat, a.lon, a.destLat, a.destLon);
    if (total < 150 || left > total * 1.15) return null;
    const pct = Math.max(1, Math.min(99, Math.round((1 - left / total) * 100)));
    const kmh = (a.gs ?? 0) * 1.852;
    const hrs = kmh > 200 ? left / kmh : 0;
    const eta = hrs > 0 ? `, with roughly ${hrs >= 1.5 ? hrs.toFixed(1) + " hours" : Math.max(5, Math.round((hrs * 60) / 5) * 5) + " minutes"} still to fly` : "";
    return `${a.originName ?? a.origin} to ${a.destName ?? a.destination} is about ${n0(Math.round(total / 10) * 10)} km along the curve of the Earth. This flight is around ${pct}% of the way there${eta}.`;
  }],
  ["people", (_c, v) => {
    const t = (v.ac.typeCode ?? "").toUpperCase();
    const hit = TYPES.find(([re]) => re.test(t));
    return hit ? `An aircraft like this typically seats around ${hit[2]} people. Each of them is on the way to someone, or away from someone.` : null;
  }],
  ["lookdown", (c, v) => (c.sunAlt < -6 && v.rangeKm < 120 ? "Someone in a window seat up there may be looking down right now at the lights of your town, wondering who is awake." : null)],
  ["descent", (_c, v) => ((v.ac.baroRate ?? 0) < -700 ? "This aircraft is on its way down. Airliners descend at about three degrees — some 300 m lost for every five kilometres flown — so the descent begins far from the runway." : null)],
  ["climb", (_c, v) => ((v.ac.baroRate ?? 0) > 1200 ? "This aircraft is climbing. A loaded airliner takes about twenty minutes and well over a hundred kilometres to reach its cruising height." : null)],
];

// ---- how flying works ----
const FLYING: string[] = [
  "Red on the left wingtip, green on the right, white at the tail — the same rule ships have used for two centuries. From the colours you can tell which way an aircraft is going.",
  "The white flashes at the wingtips are strobes, so other pilots can find the aircraft. The slower red flash on the belly or roof is the beacon, lit whenever the engines are running.",
  "A contrail is a cloud made by hand. Water vapour in the exhaust freezes into ice crystals in air colder than about −40 °C. A long-lived trail means the air up there is already humid.",
  "Airliners cruise near 11 km because the air is thin enough to slip through easily yet thick enough for the engines to breathe. It is a narrow, efficient shelf of sky.",
  "Aircraft flying east generally cruise at odd thousands of feet, and those flying west at even thousands. Opposite streams pass with at least 300 m between them.",
  "The shortest path between two cities is a great circle, which looks curved on a flat map. That is why flights from India to America pass near the Arctic.",
  "Every airliner continuously announces its own position, height and speed by radio, about twice a second. Volunteers with small receivers pick these up — and that is how this wall knows where each one is.",
  "The four-digit squawk code uses only the digits 0 to 7. It is an old system: an octal number set by hand, giving 4,096 possible codes, assigned by air traffic control.",
  "Above a certain height every aircraft sets its altimeter to the same standard pressure, 1013 hectopascals. What matters up there is not true height, but that everyone agrees.",
  "An airliner's cabin is kept at the pressure of a mountain town about 2,000 m up. That is why crisps packets swell and water bottles crumple on the way down.",
  "The small hole near the bottom of an aircraft window is deliberate. It lets the outer pane carry the pressure and keeps the window from fogging.",
  "Flight recorders are called black boxes but are painted bright orange, so they can be found.",
  "Aircraft tyres are filled with nitrogen rather than air, and touch down at around 250 km/h. A set lasts a few hundred landings.",
  "An airliner is struck by lightning about once a year on average. The current runs along the metal skin and leaves from the tail or a wingtip; those aboard may notice only a flash.",
  "An airliner's wings are built to bend. On a large jet the tips can flex upward by several metres in flight — which is exactly what keeps the ride smooth.",
  "Cabin lights are dimmed for night take-offs and landings so that everyone's eyes are already adjusted to the dark, should they need to find their way out.",
  "Most airliners cruise at about 80 percent of the speed of sound. Any faster and shock waves form over the wing, and fuel burn climbs steeply.",
  "The little fins at a wingtip can save three to five percent of a flight's fuel by calming the whirlpool of air that spills around the tip.",
  "At any moment, more than ten thousand airliners are in the air around the world, carrying something like a million people — a city that never lands all at once.",
  "Pilots and controllers everywhere speak English on the radio, with a spelling alphabet — Alfa, Bravo, Charlie — chosen so each word survives a bad connection in any accent.",
  "Runways are numbered by compass direction, with the last digit dropped. Runway 28 points roughly west, at 280 degrees; its other end is runway 10.",
  "Because magnetic north slowly wanders, airports occasionally have to repaint their runway numbers.",
  "Twin-engine airliners may cross oceans only along routes where, on one engine, they could still reach an airport within a set time. The rule shaped the map of every long flight.",
  "A flight's callsign and its ticket number are often different. Airlines change similar-sounding callsigns so that two crews on one frequency are not confused.",
  "Clear-air turbulence has no cloud to mark it. It gathers at the edges of jet streams, where fast and slow rivers of air rub against each other.",
  "For most of a flight the aircraft is steered by its computers along a line of invisible waypoints with five-letter names, each chosen to be pronounceable.",
  "Jet fuel is carried mostly inside the wings. Its weight out there helps hold the wings down against the lift that is bending them up.",
  "An aircraft's engines are tested by firing whole birds and tonnes of water into them at full power. They must keep running.",
  "The air you breathe in a cabin is taken from outside, compressed, cooled and mixed. All of it is replaced every two to three minutes.",
  "On a long night flight the crew sleep in shifts in small hidden bunks, usually above the passenger cabin, reached by a narrow stair.",
];

// ---- the season ----
const SEASON: Item[] = [
  { id: "leonids", k: "THIS TIME OF YEAR", m: [11], t: "Mid-November brings the Leonids: grains of dust left by comet Tempel–Tuttle, meeting the Earth at 71 km per second. They are among the fastest meteors there are." },
  { id: "kartik", k: "THIS TIME OF YEAR", m: [10, 11], t: "The month of Kartik is named for Krittika, the Pleiades. Around its full moon the Moon stands near that small cluster of stars, which rides high in the evening now." },
  { id: "clearair", k: "THIS TIME OF YEAR", m: [10, 11, 12], t: "After the monsoon the air over the Himalaya is at its clearest. October and November are when the high snows show sharpest from the hill towns." },
  { id: "geese", k: "THIS TIME OF YEAR", m: [10, 11, 3, 4], t: "Bar-headed geese cross the Himalaya on migration at this time of year. They have been tracked flying above 7,000 m, by night, on their own wings." },
  { id: "jet", k: "THIS TIME OF YEAR", m: [11, 12, 1, 2, 3], t: "In winter a river of wind called the subtropical jet settles over north India and the Himalaya, often blowing above 200 km/h. Eastbound flights ride it; westbound ones push against it." },
  { id: "orion", k: "THIS TIME OF YEAR", m: [11, 12, 1, 2], t: "Orion rises in the east on winter evenings. The three stars of his belt point down toward Sirius, the brightest star in the night sky." },
  { id: "fog", k: "THIS TIME OF YEAR", m: [12, 1, 2], t: "Winter fog lies over the plains of north India on still nights. Seen from an aircraft above, it is a white sea with only the tallest towers showing." },
  { id: "geminids", k: "THIS TIME OF YEAR", m: [12], t: "Mid-December brings the Geminids, the year's richest meteor shower. Unusually, their parent is not a comet but a rocky asteroid called Phaethon." },
  { id: "solstice", k: "THIS TIME OF YEAR", m: [12], t: "Around the 21st of December the Sun stands still at its southernmost point. These are the longest nights of the year for watching the sky." },
  { id: "perseids", k: "THIS TIME OF YEAR", m: [8], t: "August brings the Perseids, dust from comet Swift–Tuttle. On the peak nights, between the monsoon clouds, there can be one a minute." },
  { id: "monsoon", k: "THIS TIME OF YEAR", m: [6, 7, 8, 9], t: "In the monsoon, pilots thread between thunderheads that tower to 15 km. Their weather radar paints the wettest cores in red, and they fly around them." },
  { id: "summerheat", k: "THIS TIME OF YEAR", m: [4, 5, 6], t: "Hot air is thin air. On the hottest afternoons aircraft need longer runways to take off, and some heavy flights are scheduled for the cool of night instead." },
  { id: "scorpius", k: "THIS TIME OF YEAR", m: [5, 6, 7, 8], t: "On summer evenings the red star Antares glows low in the south. Its name means rival of Mars." },
  { id: "hajj-night", k: "THE NIGHT SHIFT", t: "Long flights between Europe and East Asia are timed to leave in the evening and arrive in the morning. That is why so many of them cross India in the middle of the night." },
  { id: "freight", k: "THE NIGHT SHIFT", t: "A good share of the traffic after midnight is freight: letters, medicines, flowers, machine parts, fish on ice. The world's deliveries move while it sleeps." },
];

// ---- the sky and the wider world ----
const SKY: Item[] = [
  { id: "polaris", k: "THE SKY ABOVE YOU", t: (c) => `The Pole Star stands as many degrees above your northern horizon as your latitude: about ${Math.round(Math.abs(c.lat))}° here. Sailors found their way home by that one fact.` },
  { id: "spin", k: "THE SKY ABOVE YOU", t: (c) => `You are not lying still. The turning Earth is carrying your bed eastward at about ${n0(Math.round((1670 * Math.cos(c.lat * D2R)) / 10) * 10)} km/h.` },
  { id: "orbit", k: "THE SKY ABOVE YOU", t: "In the time it takes to read this line slowly, the Earth has carried you about 300 km along its path around the Sun." },
  { id: "satsdusk", k: "THE SKY ABOVE YOU", t: "Satellites shine only by reflected sunlight. You see them just after dusk and before dawn, when the ground is dark but they are still high enough to be in the Sun." },
  { id: "iss", k: "THE SKY ABOVE YOU", t: "The space station circles the Earth about every 92 minutes, at 7.7 km per second. Its crew see sixteen sunrises every day." },
  { id: "starlight", k: "THE SKY ABOVE YOU", t: "The light of even the nearest star you can see tonight has been travelling for years. You are looking at many different moments of the past at once." },
  { id: "sirius", k: "THE SKY ABOVE YOU", t: "Sirius, the brightest star of the night, is also one of the nearest: its light takes about eight and a half years to arrive." },
  { id: "betel", k: "THE SKY ABOVE YOU", t: "Betelgeuse, the orange star at Orion's shoulder, is a dying giant. Put in place of the Sun, it would swallow the Earth and reach out past Mars." },
  { id: "milky", k: "THE SKY ABOVE YOU", t: "The pale band of the Milky Way is our own galaxy seen edge-on from inside: a few hundred billion suns, too distant to tell apart." },
  { id: "moonaway", k: "THE SKY ABOVE YOU", t: "The Moon is drifting away from the Earth by about 3.8 cm a year — roughly the speed at which fingernails grow." },
  { id: "twinkle", k: "THE SKY ABOVE YOU", t: "Stars twinkle and planets mostly do not. A star is a single point of light, easily bent by moving air; a planet is a tiny disc, and its shimmer averages out." },
  { id: "saturn", k: "THE SKY ABOVE YOU", t: "Saturn's rings are wide enough to span most of the distance from the Earth to the Moon, yet in many places they are only about ten metres thick." },
  { id: "meteor", k: "THE SKY ABOVE YOU", t: "Most shooting stars are no bigger than a grain of sand. They burn up about 90 km overhead — nearly ten times higher than the aircraft." },
  { id: "dark", k: "THE SKY ABOVE YOU", t: "Your eyes take about twenty minutes to adjust fully to the dark. The longer you lie here, the more stars there will seem to be." },
  { id: "hump", k: "THE WIDER WORLD", t: "Airliners between India and China mostly go around Tibet rather than over it. If a cabin lost pressure they would need to descend to breathable air, and the plateau is higher than that." },
  { id: "silk", k: "THE WIDER WORLD", t: "Many of the airways above you follow the same lines as the old caravan and sea routes: Arabia to India, India to China. The trade is the same; only the height has changed." },
  { id: "timezones", k: "THE WIDER WORLD", t: "On the aircraft above, it is no particular time at all. Passengers left in one evening and will land in another morning; their watches are simply waiting." },
  { id: "everyone", k: "THE WIDER WORLD", t: "Every light crossing your sky tonight is a few hundred strangers sitting quietly together in the dark, trusting two people at the front whom they will never meet." },
  { id: "controllers", k: "THE WIDER WORLD", t: "Each aircraft you see is being watched by a controller in a dim room somewhere, who will hand it to the next room, and the next, all the way across the world." },
  { id: "kanch", k: "THE WIDER WORLD", t: "Kangchenjunga was believed to be the highest mountain in the world until 1852. By tradition, climbers stop just short of its summit, leaving the top untrodden." },
  { id: "first", k: "THE WIDER WORLD", t: "The first powered flight, in 1903, lasted twelve seconds and covered 37 m — less than the length of the aircraft passing over you tonight." },
  { id: "mail", k: "THE WIDER WORLD", t: "The world's first official airmail was flown in India, in 1911: 6,500 letters carried across the Yamuna from Allahabad to Naini, a journey of thirteen minutes." },
  { id: "tata", k: "THE WIDER WORLD", t: "J.R.D. Tata held the first pilot's licence issued in India, in 1929. Three years later he started the airline that became Air India." },
  { id: "hump-war", k: "THE WIDER WORLD", t: "In the 1940s, pilots flew supplies from Assam to China over the eastern Himalaya, in unpressurised aircraft, through ice and monsoon. They called the route the Hump." },
];

// The state of the world's air routes. Dated where the fact has a date, because
// these change; written from general knowledge, not fetched tonight.
const ROUTES: string[] = [
  "Since 2022 most European and American airlines have not flown over Russia. Their flights between Europe and East Asia now bend south across Turkey and Central Asia, an hour or two longer each way.",
  "In April 2025 Pakistan closed its sky to Indian airlines, and India did the same in return. Flights from Delhi to Europe and America swung south over the Arabian Sea. Closures like this are renewed a month at a time; the tracks above you show whether it still holds tonight.",
  "Almost no long-distance airliner crosses the Tibetan plateau. If a cabin loses pressure the aircraft must get down to breathable air within minutes, and the ground there is higher than that for a thousand kilometres. So the traffic flows around it, much of it past the hills of north Bengal.",
  "Most of the sky over Afghanistan has had no air traffic control since August 2021. Aircraft still cross it, high up, on a few fixed routes, telling one another where they are on a shared frequency.",
  "In winter a river of wind, the subtropical jet stream, settles over northern India at cruising height, often blowing from the west at 200 km/h or more. Eastbound flights ride it. Westbound flights pay for it.",
  "Far out over the Bay of Bengal and the Arabian Sea no ground radar can see an aircraft. There they are kept apart by time and distance, and report their positions through satellites, much as ships once did by radio.",
  "The invisible roads of the sky are marked by waypoints with five-letter names, invented so that a pilot of any language can say them. Controllers clear aircraft from one to the next like stepping stones.",
  "In June 2025, during the fighting between Israel and Iran, the skies over Iran, Iraq, Israel and Jordan emptied for days. Flights between Europe and India were squeezed into narrow corridors to the south and north.",
];

// We cannot know who is flying a given aircraft, and should not: crew names are
// not public. This is what is true of whoever it is.
const CREW: string[] = [
  "The names of the pilots above you are in no public record, and rightly so. What is certain is that the captain holds an airline transport licence, which takes at least 1,500 hours in the air to earn. Most have many times that.",
  "Every six months each airline pilot is put in a simulator and handed the worst day of a career: an engine fire, failed hydraulics, a blocked runway. They must fly it calmly, or stop flying.",
  "The captain sits on the left, the first officer on the right. For half of every day's flights the first officer is the one actually flying, while the captain works the radio.",
  "On flights longer than eight or nine hours there are three or four pilots aboard. The ones off duty sleep in a small hidden bunk room, usually just behind or above the flight deck.",
  "Cabin crew are aboard for safety before service. Each is trained to help empty the whole aircraft in ninety seconds using only half its doors.",
  "The law limits how many hours a pilot may be on duty and how many night landings they may make in a row. Tiredness is treated as a hazard, like ice.",
];

const WMO = (code: number): string =>
  code === 0 ? "clear" : code <= 2 ? "fair with some cloud" : code === 3 ? "overcast" : code <= 48 ? "foggy" : code <= 57 ? "drizzling"
    : code <= 67 ? "raining" : code <= 77 ? "snowing" : code <= 82 ? "showery" : code <= 86 ? "snowing" : "stormy, with thunder about";
const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(Math.round(min % 60)).padStart(2, "0")}`;
const WINDS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const niceDay = (iso: string): string => {
  const d = new Date(iso + "T12:00:00");
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
};

/** Lines only this house could show: what it remembers, and the far end of the route. */
function personal(c: LoreCtx, v: CraftView, call: string): Item[] {
  const a = v.ac;
  const x = c.extra;
  if (!x) return [];
  const out: Item[] = [];
  const day = c.date.toISOString().slice(0, 10);
  const K = `${call}  ·  OUR SKY REMEMBERS`;
  const reg = a.registration || x.seen?.craft?.reg;
  const cr = x.seen?.craft;
  if (cr && cr.days > 1) {
    const prev = cr.prev ? ` Last time, on ${niceDay(cr.prev.date)}, it was ${cr.prev.flight ? "flying as " + cr.prev.flight : "here"}${cr.prev.route ? ", " + cr.prev.route : ""}.` : "";
    out.push({ id: `mem:craft:${a.hex}:${day}`, k: K, t: `We know this one. ${reg ? reg + " has" : "This very aircraft has"} crossed the sky above ${c.place} on ${cr.days} different days since ${niceDay(cr.first)}.${prev}` });
  } else if (cr && x.seen && x.seen.aircraftKnown > 20) {
    out.push({ id: `mem:new:${a.hex}`, k: K, t: `A stranger. ${reg ? reg + " has" : "This aircraft has"} not crossed the sky above ${c.place} before, in all the time we have kept count. It is number ${n0(x.seen.aircraftKnown)} in our book.` });
  }
  const fl = x.seen?.flight;
  if (fl && fl.days >= 3 && fl.usualMin != null) {
    const d = fl.todayMin - fl.usualMin;
    const how = Math.abs(d) <= 7 ? "right on its usual time" : `${Math.abs(d)} minutes ${d > 0 ? "later" : "earlier"} than usual`;
    out.push({ id: `mem:flight:${call}:${day}`, k: K, t: `${call} is a regular. We have watched it pass on ${fl.days} days, usually at about ${hhmm(fl.usualMin)}. Today it appeared at ${hhmm(fl.todayMin)}, ${how}.` });
  }
  const dn = a.destName ?? a.destination;
  if (x.dest && dn && x.dest.temperature_2m != null && x.dest.timezone) {
    let clock = "";
    try {
      clock = c.date.toLocaleTimeString("en-GB", { timeZone: x.dest.timezone, hour: "2-digit", minute: "2-digit" });
    } catch {
      clock = "";
    }
    const km = a.lat != null && a.lon != null && a.destLat != null && a.destLon != null ? gcKm(a.lat, a.lon, a.destLat, a.destLon) : null;
    const mins = km != null && a.gs && a.gs > 120 ? (km / (a.gs * 1.852)) * 60 + 6 : null;
    const eta = mins == null ? "" : mins < 90 ? ` in about ${Math.max(5, Math.round(mins / 5) * 5)} minutes` : ` in about ${(mins / 60).toFixed(1)} hours`;
    out.push({
      id: `dest:${a.hex}:${day}`, k: `${call}  ·  WAITING AT THE OTHER END`,
      t: `In ${dn} it is ${clock ? clock + ", " : ""}${Math.round(x.dest.temperature_2m)} °C and ${WMO(x.dest.weather_code ?? 0)}. That is the air the people aboard will step out into${eta}.`,
    });
  }
  const alt = a.altGeom ?? a.altBaro ?? 0;
  if (x.aloft && alt > 28000 && a.track != null && x.aloft.wind_speed_250hPa != null && x.aloft.wind_direction_250hPa != null && x.aloft.wind_speed_250hPa > 35) {
    const w = x.aloft.wind_speed_250hPa;
    const from = x.aloft.wind_direction_250hPa;
    const tail = Math.round(w * Math.cos((from + 180 - a.track) * D2R));
    const dir = WINDS[Math.round(from / 45) % 8];
    const effect = Math.abs(tail) < 25 ? "It is blowing almost straight across its path, so the nose is pointed a little into it"
      : tail > 0 ? `A push from behind of about ${n0(tail)} km/h, free of charge` : `It is pushing against the nose at about ${n0(-tail)} km/h, and the fuel pays for it`;
    out.push({ id: `wind:${a.hex}:${day}`, k: `${call}  ·  THE WIND IT IS IN`, t: `Up where ${call} is, the wind is blowing at ${n0(w)} km/h from the ${dir}. ${effect}.` });
  }
  return out;
}

const ORDER = ["flight", "seat", "flying", "now", "seat", "sky", "flight", "seat", "routes", "season", "seat", "flying", "flight", "crew", "seat", "now", "sky"] as const;

export class Lore {
  private seen = new Set<string>();
  private turn = 0;
  private seat = 0;

  private flightItems(c: LoreCtx): Item[] {
    const v = c.focus;
    if (!v) return [];
    const a = v.ac;
    const call = (a.flight || a.registration || displayHex(a.hex)).trim();
    const out: Item[] = personal(c, v, call);
    const t = (a.typeCode ?? "").toUpperCase();
    const hit = TYPES.find(([re]) => re.test(t));
    if (hit) hit[3].forEach((text, i) => out.push({ id: `type:${hit[1]}:${i}`, k: `${call}  ·  THE ${hit[1].toUpperCase()}`, t: text }));
    const al = AIRLINES[(a.flight ?? "").slice(0, 3).toUpperCase()];
    if (al) al.forEach((text, i) => out.push({ id: `air:${(a.flight ?? "").slice(0, 3)}:${i}`, k: `${call}  ·  ITS AIRLINE`, t: text }));
    for (const [code, label] of [[a.origin, "WHERE IT CAME FROM"], [a.destination, "WHERE IT IS GOING"]] as const) {
      const ap = code ? AIRPORTS[code.toUpperCase()] : undefined;
      if (ap) ap.forEach((text, i) => out.push({ id: `apt:${code}:${i}`, k: `${call}  ·  ${label}`, t: text }));
    }
    for (const [name, fn] of CALC) out.push({ id: `calc:${name}:${a.hex}`, k: `${call}  ·  RIGHT NOW`, t: (cc) => fn(cc, v) });
    return out;
  }

  /** The next thing to say. `now` supplies a live fact for the "now" turns. */
  next(c: LoreCtx, now: () => string): LoreLine | null {
    const month = c.date.getMonth() + 1;
    for (let tries = 0; tries < ORDER.length; tries++) {
      const cat = ORDER[this.turn++ % ORDER.length];
      if (cat === "now") {
        const text = now();
        if (text) return { kicker: "RIGHT NOW", text };
        continue;
      }
      if (cat === "seat") {
        // Move one seat along each time: window, galley, flight deck, radar room.
        for (let k = 0; k < SEATS.length && c.focus; k++) {
          const sc = seatScene(SEATS[this.seat++ % SEATS.length], c.focus, c.date, c.observerKm, (id) => this.seen.has(id));
          if (!sc) continue;
          this.seen.add(sc.id);
          return { kicker: sc.kicker, text: sc.text };
        }
        continue;
      }
      const pool: Item[] =
        cat === "flight" ? this.flightItems(c)
          : cat === "flying" ? FLYING.map((t, i) => ({ id: `fly:${i}`, k: "ABOUT FLYING", t }))
            : cat === "routes" ? ROUTES.map((t, i) => ({ id: `rt:${i}`, k: "THE STATE OF THE ROUTES", t }))
              : cat === "crew" ? CREW.map((t, i) => ({ id: `crew:${i}`, k: "WHO IS FLYING", t }))
            : cat === "season" ? SEASON.filter((s) => !s.m || s.m.includes(month))
              : SKY;
      let fresh = pool.filter((p) => !this.seen.has(p.id));
      if (!fresh.length && pool.length && cat !== "flight") {
        // The well ran dry: start that subject again.
        for (const p of pool) this.seen.delete(p.id);
        fresh = pool;
      }
      // Try a few at random; computed lines may not apply to this aircraft.
      for (let k = 0; k < 6 && fresh.length; k++) {
        const pick = fresh.splice(Math.floor(Math.random() * fresh.length), 1)[0];
        const text = typeof pick.t === "string" ? pick.t : pick.t(c);
        this.seen.add(pick.id);
        if (text) return { kicker: pick.k, text };
      }
    }
    return null;
  }
}
