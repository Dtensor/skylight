// Four places to sit while an aircraft crosses the wall: the radar room, the
// flight deck, the galley with the cabin crew, and a window seat.
//
// Which scene is shown depends on the flight's phase, worked out from what it
// is measurably doing (height, climb or descent, distance to each end of its
// route, the hour on board). The scenes themselves describe what customarily
// happens at that moment on an airliner — they are not reports from on board.

import type { CraftView } from "./aircraft.js";

export type Seat = "tower" | "deck" | "galley" | "window";
export type Phase = "takeoff" | "climb" | "cruise" | "night" | "predescent" | "descent" | "approach" | "final";
export const SEATS: Seat[] = ["window", "galley", "deck", "tower"];
const KICKER: Record<Seat, string> = {
  tower: "IN THE RADAR ROOM",
  deck: "ON THE FLIGHT DECK",
  galley: "WITH THE CABIN CREW",
  window: "IN THE WINDOW SEAT",
};

function gcKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const D = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * D) / 2) ** 2 + Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(((lon2 - lon1) * D) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

export interface Situation {
  phase: Phase;
  /** Dark outside the aircraft's windows. */
  dark: boolean;
  destKm: number | null;
  minsToGo: number | null;
}

export function situation(v: CraftView, date: Date, observerKm: number): Situation | null {
  const a = v.ac;
  const alt = a.altGeom ?? a.altBaro;
  if (alt == null || a.lat == null || a.lon == null) return null;
  // Light aircraft and helicopters have no galley; keep this to airliners.
  if (!a.flight || /^(A1|A7|B|C)/.test(a.category ?? "")) return null;
  const rate = a.baroRate ?? 0;
  const agl = alt - observerKm * 3280.84;
  const destKm = a.destLat != null && a.destLon != null ? gcKm(a.lat, a.lon, a.destLat, a.destLon) : null;
  // Mean solar time at the aircraft is close enough to tell night from day.
  const solar = (((date.getUTCHours() + date.getUTCMinutes() / 60 + a.lon / 15) % 24) + 24) % 24;
  const dark = solar < 5.5 || solar > 18.75;
  const minsToGo = destKm != null && a.gs && a.gs > 120 ? Math.round((destKm / (a.gs * 1.852)) * 60) + 6 : null;
  let phase: Phase;
  if (rate > 500) phase = alt < 10000 ? "takeoff" : "climb";
  else if (rate < -500) phase = destKm != null && destKm < 25 && agl < 3200 ? "final" : alt < 10000 ? "approach" : "descent";
  else if (alt < 9000) phase = "approach";
  else if (destKm != null && destKm < 330 && alt > 20000) phase = "predescent";
  else phase = solar >= 22.5 || solar < 5 ? "night" : "cruise";
  return { phase, dark, destKm, minsToGo };
}

type Line = string | [day: string, night: string];
const SCENES: Record<Phase, Record<Seat, Line[]>> = {
  takeoff: {
    tower: [
      "On the departure controller's screen {call} is a small tag climbing through {alt}. For the next three minutes the job is to thread it upward between the arrivals coming down.",
    ],
    deck: [
      "Both pilots have their hands and eyes full. Below 10,000 feet the rule is a sterile cockpit: no word that is not about flying. Wheels up, flaps in, the checklist read aloud, call and answer.",
    ],
    galley: [
      "The cabin crew are still strapped into their jump seats, facing backward. They feel the nose tilt up and hear the wheels thump into their bays. Nobody moves until the chime.",
    ],
    window: [[
      "From the window of {call} the ground is tilting away: rooftops, a river, fields laid out like cloth. Ears pop. Somewhere behind, a small child objects to the whole idea.",
      "From the window of {call} the city is tilting away: strings of orange street lights, then a dark patch that is a river or a park. Ears pop. Somewhere behind, a small child objects to the whole idea.",
    ]],
  },
  climb: {
    tower: [
      "{call} has just been passed from the departure controller to the area centre, a windowless room that may be hundreds of kilometres away. One controller there watches a slab of sky the size of a small country.",
    ],
    deck: [
      "The autopilot is flying now; the pilots are managing rather than steering. Climb power is set, the after-take-off checks are done, and one of them is already asking the controller for a shortcut.",
    ],
    galley: [
      "The chime has sounded. In the galley the ovens are switched on and the carts unlatched. The floor is still sloping uphill, so the cart brakes matter. Passing {alt}, the first trays are being loaded.",
    ],
    window: [[
      "The seatbelt sign has gone off with a soft double chime. Seats recline, a tray table clicks down two rows ahead, and the window is full of cloud tops in hard sunlight.",
      "The seatbelt sign has gone off with a soft double chime. Seats recline, a tray table clicks down two rows ahead, and the window shows only the wing-tip light pulsing against the dark.",
    ]],
  },
  cruise: {
    tower: [
      "To its controller, {call} is one of a dozen or so tags sliding across a dark screen, each kept a thousand feet above or below the next and several miles apart. A quiet sector is a good sector.",
      "Somewhere a controller wearing a headset has {call} written on a strip, and will say perhaps four sentences to it in the whole time it crosses this sky.",
    ],
    deck: [
      "At cruise the flight deck is calm. Every so often the pilots compare the fuel used with the plan, look again at the weather at {dest}, and note which airport they would turn to from here if they had to.",
      "On the flight deck of {call} one pilot is flying and the other is watching — and they will have agreed, before leaving the gate, which is which. On the way back they usually swap.",
    ],
    galley: [
      "Service is under way: carts in the aisle, the smell of warmed bread, a hand raised for water. Behind the curtain someone is counting meals against the list of special orders.",
      "In the galley of {call} the crew eat standing up, in turns, between calls. The two pilots are customarily given different meals, so one bad dish cannot trouble both.",
    ],
    window: [
      "A window seat on {call}. The engines have settled to a steady hush, the cabin air is drier than a desert, and a hand's width away, beyond the glass, it is about {out} °C.",
      [
        "From up there the land below {call} looks drawn rather than built: rivers as silver thread, fields as patchwork, and no borders at all.",
        "From up there the towns below {call} are small spills of light joined by threads of road. One of the smallest of them may be us.",
      ],
    ],
  },
  night: {
    tower: [
      "It is the night shift in the control centre. Screens glow, the radio stays silent for a minute at a time, and {call} crosses the sector with little more than a good night at each end.",
    ],
    deck: [
      "The flight deck lights are turned right down so the pilots' eyes stay used to the dark. On a clear night they can see a city from a hundred and fifty kilometres off, and other aircraft as slow, silent strobes.",
      "On long night flights the pilots sometimes take turns to close their eyes for twenty minutes in the seat, one always awake and flying. It is planned, announced to the cabin crew, and logged.",
    ],
    galley: [
      "The cabin lights are down to a deep blue. Service is over. The crew sit in the galley with tea, talking low, and every twenty minutes one of them walks the aisle with a torch pointed at the floor.",
    ],
    window: [
      "Most of the cabin of {call} is asleep under thin blankets. A few reading lights, a few screens. Someone by a window has the shade half up and is looking down at lights — perhaps at ours.",
      "On {call} it is the hour when a long flight goes quiet: the hum, the dark, a seat neighbour's slow breathing, and outside about {out} °C under more stars than the ground ever sees.",
    ],
  },
  predescent: {
    tower: [
      "A controller is about to start {call} down, timed so that it reaches {dest} at the right height and in the right order. The queue for a runway is formed three hundred kilometres away from it.",
    ],
    deck: [
      "The pilots are briefing the arrival into {dest}: which runway, the weather waiting there, and exactly what they will do if they have to abandon the landing. It is said aloud every time, even on a route flown a thousand times.",
    ],
    galley: [
      "In the galley everything loose is being put away: carts locked into their bays, ovens off, pots emptied. The crew know the descent is coming before the passengers do.",
    ],
    window: [
      "About {mins} minutes to {dest}. People on {call} are beginning to stir, find their shoes, queue for the lavatory. On the seat-back map the little aircraft is almost touching the city.",
    ],
  },
  descent: {
    tower: [
      "{call} is coming down through {alt}. Its controller is turning streams of arrivals from several directions into one line, each aircraft a few minutes behind the last.",
    ],
    deck: [
      "The engines are close to idle and the aircraft is gliding down a slope of about three degrees, giving up roughly three hundred feet for every mile forward. The altimeters are about to be reset to the air pressure at {dest}.",
    ],
    galley: [
      "The crew are walking the aisle one last time: seat backs upright, tray tables stowed, bags pushed under the seat in front. A sleeping passenger is woken, gently, to fasten a belt.",
    ],
    window: [[
      "The engine note on {call} has fallen away and ears are starting to feel it. Out of the window the haze has an edge now, and under it the first roads.",
      "The engine note on {call} has fallen away and ears are starting to feel it. Out of the window the horizon has a faint glow: the first sign of {dest}.",
    ]],
  },
  approach: {
    tower: [
      "The approach controller has {call} on a short lead now: a heading, a height and a speed, every minute or so. On the screen the aircraft are beads being drawn onto one string that ends at the runway.",
    ],
    deck: [
      "Flaps are sliding out in stages and the aircraft is slowing toward its landing speed. The landing checklist is read. From here the pilots speak only about the approach.",
    ],
    galley: [
      "The cabin crew are in their jump seats with harnesses on. Each is silently running a thirty-second review: which door is mine, how does it open, what do I shout. They do it before every landing.",
    ],
    window: [[
      "Through the window of {call} the ground has detail again: roads, lorries, a flyover, a cricket ground with a match in progress that nobody on board will see the end of.",
      "The cabin lights are dimmed so that eyes are ready for the dark outside. Through the window the ground has detail again: roads, headlights, a flyover, a floodlit cricket ground.",
    ]],
  },
  final: {
    tower: [[
      "From the tower's windows {call} is a bright shape on the approach, growing slowly. The controller checks that the runway is empty, glances at the wind, and clears it to land.",
      "From the tower's windows {call} is a pair of bright landing lights hanging in the dark, growing slowly. The controller checks that the runway is empty, glances at the wind, and clears it to land.",
    ]],
    deck: [
      "A recorded voice on the flight deck is counting the height: five hundred... one hundred... fifty, thirty, twenty, ten. At about thirty feet the pilot eases the nose up, closes the thrust levers, and waits for the wheels.",
    ],
    galley: [
      "Nobody in the cabin is speaking. The crew sit upright, feet flat on the floor. Then the thump, the roar of the engines thrown into reverse, and the first voice on the speakers: welcome.",
    ],
    window: [
      "Rooftops, then the airport fence, then the painted numbers of the runway sliding under the wing of {call}. In a few seconds a cabin full of telephones will light up at once.",
    ],
  },
};

const n0 = (v: number): string => Math.round(v).toLocaleString("en-US");

/** One scene from the given seat for this aircraft, or null if nothing fits. */
export function seatScene(seat: Seat, v: CraftView, date: Date, observerKm: number, skip: (id: string) => boolean): { id: string; kicker: string; text: string } | null {
  const s = situation(v, date, observerKm);
  if (!s) return null;
  const a = v.ac;
  const call = (a.flight ?? a.hex).trim();
  const alt = a.altGeom ?? a.altBaro ?? 0;
  const list = SCENES[s.phase][seat];
  for (let i = 0; i < list.length; i++) {
    const id = `seat:${seat}:${s.phase}:${a.hex}:${i}`;
    if (skip(id)) continue;
    const raw = list[i];
    let text = typeof raw === "string" ? raw : raw[s.dark ? 1 : 0];
    if (text.includes("{mins}") && s.minsToGo == null) continue;
    if (text.includes("{dest}") && !(a.destName ?? a.destination)) {
      text = text.replace(/ at \{dest\}| into \{dest\}| to \{dest\}/g, (m) => (m.startsWith(" to") ? " to landing" : " at the far end")).replace(/\{dest\}/g, "its destination");
    }
    // Standard atmosphere: 15 °C at sea level, about 2 °C colder per 1,000 ft, to -56.5.
    const out = Math.max(-56.5, 15 - 1.98 * (alt / 1000));
    text = text
      .replace(/\{call\}/g, call)
      .replace(/\{dest\}/g, a.destName ?? a.destination ?? "")
      .replace(/\{alt\}/g, `${n0(Math.round(alt / 100) * 100)} feet`)
      .replace(/\{mins\}/g, String(s.minsToGo ?? ""))
      .replace(/\{out\}/g, `${out < 0 ? "minus " : ""}${Math.abs(Math.round(out))}`);
    return { id, kicker: `${call}  ·  ${KICKER[seat]}`, text };
  }
  return null;
}
