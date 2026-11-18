// What is probably being said, right now, about the aircraft you are watching.
//
// No recording is involved. Each exchange is rebuilt from what the aircraft is
// measurably doing — leaving its cruising level, levelling off, turning onto a
// new heading, changing radar code, coming down the final approach — and uses
// only numbers that were observed (its level, its heading, its code, the wind).
// The wording is standard radiotelephony; the cabin announcements are the
// customary ones for that moment. Shown and spoken as "reconstructed".

import type { CraftView } from "./aircraft.js";

export interface RadioLine {
  who: string;
  text: string;
  /** Plain words for the speech engine (digits spelt out). */
  speak: string;
  /** Playback pitch, so two speakers sound like two people. */
  pitch: number;
}

export interface RadioCall {
  hex: string;
  channel: "radio" | "cabin";
  lines: RadioLine[];
  meaning: string;
  pri: number;
  at: number;
}

// Radio names of airlines (ICAO three-letter prefix -> what is said aloud).
const TELEPHONY: Record<string, string> = {
  IGO: "IFly", AIC: "Air India", AXB: "Express India", AKJ: "Akasa Air", SEJ: "SpiceJet", VTI: "Vistara",
  THA: "Thai", CPA: "Cathay", UAE: "Emirates", QTR: "Qatari", SIA: "Singapore", DRK: "Royal Bhutan",
  EVA: "Eva", CAL: "Dynasty", CSN: "China Southern", CES: "China Eastern", CCA: "Air China", HVN: "Vietnam Airlines",
  KLM: "KLM", BAW: "Speedbird", DLH: "Lufthansa", THY: "Turkish", FDX: "FedEx", UPS: "UPS", MAS: "Malaysian",
  KAL: "Korean Air", ANA: "All Nippon", JAL: "Japan Air", SVA: "Saudia", ETD: "Etihad", BBC: "Bangladesh",
  RNA: "Royal Nepal", BHA: "Buddha Air", UBG: "Bangla Star", KAC: "Kuwaiti", ABY: "Arabia", AFR: "Air France",
  UAL: "United", AAL: "American", DAL: "Delta", ACA: "Air Canada", QFA: "Qantas", SWR: "Swiss", AUA: "Austrian",
  FIN: "Finnair", SAS: "Scandinavian", RYR: "Ryanair", EZY: "Easy", AFL: "Aeroflot", ELY: "El Al", ETH: "Ethiopian",
  GFA: "Gulf Air", OMA: "Oman Air", ALK: "Sri Lankan", AXM: "Red Cap", TGW: "Scooter", SLK: "Silkair", CEB: "Cebu",
  PAL: "Philippine", GIA: "Indonesia", AIQ: "Thai Asia", VJC: "Vietjet", HKE: "Hongkong Shuttle", CRK: "Bauhinia",
};
const DIGIT = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];
const LETTER: Record<string, string> = {
  A: "alfa", B: "bravo", C: "charlie", D: "delta", E: "echo", F: "foxtrot", G: "golf", H: "hotel", I: "india",
  J: "juliett", K: "kilo", L: "lima", M: "mike", N: "november", O: "oscar", P: "papa", Q: "quebec", R: "romeo",
  S: "sierra", T: "tango", U: "uniform", V: "victor", W: "whiskey", X: "x-ray", Y: "yankee", Z: "zulu",
};

const spell = (s: string): string => s.toUpperCase().split("").map((ch) => (/\d/.test(ch) ? DIGIT[Number(ch)] : LETTER[ch] ?? "")).filter(Boolean).join(" ");

function callsign(flight: string): { show: string; say: string } {
  const f = flight.trim().toUpperCase();
  const tele = TELEPHONY[f.slice(0, 3)];
  if (tele && f.length > 3) return { show: `${tele} ${f.slice(3)}`, say: `${tele} ${spell(f.slice(3))}` };
  return { show: f, say: spell(f) };
}

function level(ft: number): { show: string; say: string } {
  if (ft >= 18000) {
    const fl = String(Math.round(ft / 1000) * 10).padStart(3, "0");
    return { show: `flight level ${fl}`, say: `flight level ${spell(fl)}` };
  }
  const r = Math.round(ft / 100) * 100;
  const th = Math.floor(r / 1000);
  const hu = (r % 1000) / 100;
  return {
    show: `${r.toLocaleString("en-US")} feet`,
    say: `${th ? spell(String(th)) + " thousand" : ""}${hu ? " " + DIGIT[hu] + " hundred" : ""} feet`.trim(),
  };
}

function gcKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const D = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * D) / 2) ** 2 + Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(((lon2 - lon1) * D) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

type Phase = "climb" | "level" | "descend";
interface State {
  phase: Phase;
  alt: number;
  squawk?: string;
  trackRef: number;
  samples: [number, number][];
  said: Set<string>;
}

export class Radio {
  private st = new Map<string, State>();
  private queue: RadioCall[] = [];
  private lastEmit = -1e9;
  private started = -1;

  observe(tSec: number, views: CraftView[], o: { place: string; windDir: number; windKmh: number; observerFt: number }): void {
    if (this.started < 0) this.started = tSec;
    const warm = tSec - this.started > 30;
    const live = new Set<string>();
    for (const v of views) {
      const a = v.ac;
      live.add(a.hex);
      const flight = a.flight?.trim();
      const alt = a.altGeom ?? a.altBaro;
      if (!flight || alt == null) continue;
      const cs = callsign(flight);
      const rate = a.baroRate ?? 0;
      const track = a.track ?? 0;
      let s = this.st.get(a.hex);
      const push = (channel: "radio" | "cabin", pri: number, meaning: string, lines: [string, string, string, number][]) => {
        this.queue.push({ hex: a.hex, channel, pri, meaning, at: tSec, lines: lines.map(([who, text, speak, pitch]) => ({ who, text, speak, pitch })) });
      };
      const ctl = (unit: string, text: string, speak: string): [string, string, string, number] => [unit, `${cs.show}, ${text}`, `${cs.say}, ${speak}`, 0.93];
      const plt = (text: string, speak: string): [string, string, string, number] => ["PILOT", `${text}, ${cs.show}`, `${speak}, ${cs.say}`, 1.07];
      const lv = level(alt);

      if (!s) {
        s = { phase: rate > 600 ? "climb" : rate < -600 ? "descend" : "level", alt, squawk: a.squawk, trackRef: track, samples: [], said: new Set() };
        this.st.set(a.hex, s);
        if (warm && s.phase === "level" && alt > 25000 && this.queue.length < 2) {
          push("radio", 1, "Checking in with a new control centre as it enters this airspace. \"Radar contact\" means the controller has found it on the screen.", [
            ["PILOT", `${o.place} Control, ${cs.show}, ${lv.show}`, `${o.place} Control, ${cs.say}, ${lv.say}`, 1.07],
            ctl("CONTROL", `${o.place} Control, radar contact`, `${o.place} Control, radar contact`),
          ]);
        }
        continue;
      }

      const phase: Phase = rate > 600 ? "climb" : rate < -600 ? "descend" : Math.abs(rate) < 250 ? "level" : s.phase;
      const destKm = a.lat != null && a.lon != null && a.destLat != null && a.destLon != null ? gcKm(a.lat, a.lon, a.destLat, a.destLon) : null;
      const origKm = a.lat != null && a.lon != null && a.originLat != null && a.originLon != null ? gcKm(a.lat, a.lon, a.originLat, a.originLon) : null;
      const dest = a.destName ?? a.destination ?? "our destination";
      const agl = alt - o.observerFt;

      if (phase !== s.phase) {
        if (phase === "descend" && s.phase === "level" && alt > 20000) {
          push("radio", 3, "Top of descent. From here the engines are pulled back almost to idle and the aircraft glides down for the next twenty minutes or so.", [
            plt(`Leaving ${lv.show}, descending`, `Leaving ${lv.say}, descending`),
            ctl("CONTROL", "roger", "roger"),
          ]);
          const mins = destKm != null && a.gs ? Math.max(10, Math.round((destKm / (a.gs * 1.852)) * 60 / 5) * 5 + 5) : null;
          push("cabin", 3.4, "In the cabin the engine note drops, ears begin to notice, and people stir. Crew collect the last cups and blankets.", [
            ["CAPTAIN", `Ladies and gentlemen, from the flight deck: we have started our descent into ${dest}.${mins ? ` We expect to land in about ${mins} minutes.` : ""}`,
              `Ladies and gentlemen, from the flight deck. We have started our descent into ${dest}.${mins ? ` We expect to land in about ${mins} minutes.` : ""}`, 0.96],
          ]);
        } else if (phase === "level" && alt > 3000) {
          push("radio", 2, "Level again. Controllers keep aircraft apart by stacking them in steps of a thousand feet, so each one reports when it has settled on its step.", [
            plt(`Maintaining ${lv.show}`, `Maintaining ${lv.say}`),
          ]);
        } else if (phase === "climb" && s.phase === "level" && alt > 8000) {
          push("radio", 2, "Cleared higher. As it burns fuel an airliner grows lighter, and climbs in steps to thinner, more economical air.", [
            plt(`Leaving ${lv.show}, climbing`, `Leaving ${lv.say}, climbing`),
          ]);
        }
        s.phase = phase;
      }

      // Through 10,000 ft: the customary line between "busy" and "quiet" flying.
      if (s.alt < 10000 && alt >= 10000 && phase === "climb" && !s.said.has("up10")) {
        s.said.add("up10");
        push("cabin", 2.6, "Above about 10,000 ft the busiest part of the climb is over. A chime sounds, the crew unbuckle, and trolleys begin to rattle in the galley.", [
          ["CABIN CREW", "Ladies and gentlemen, the captain has switched off the seatbelt sign. You may now move around the cabin.",
            "Ladies and gentlemen, the captain has switched off the seatbelt sign. You may now move around the cabin.", 1.1],
        ]);
      }
      if (s.alt > 10000 && alt <= 10000 && phase === "descend" && !s.said.has("down10")) {
        s.said.add("down10");
        push("cabin", 3.2, "Below 10,000 ft the cockpit goes quiet by rule: only talk about flying the aircraft. Behind the door, seat backs come up and window shades are opened.", [
          ["CAPTAIN", "Cabin crew, prepare the cabin for landing.", "Cabin crew, prepare the cabin for landing.", 0.96],
        ]);
      }

      if (a.squawk && s.squawk && a.squawk !== s.squawk && /^[0-7]{4}$/.test(a.squawk)) {
        push("radio", 2.2, "A new four-digit radar code. It usually means the flight has just been handed to a different controller or a different country's airspace.", [
          ctl("CONTROL", `squawk ${a.squawk}`, `squawk ${spell(a.squawk)}`),
          plt(`Squawk ${a.squawk}`, `Squawk ${spell(a.squawk)}`),
        ]);
      }
      s.squawk = a.squawk ?? s.squawk;

      // A turn that has finished: compare with the heading it held before.
      s.samples.push([tSec, track]);
      while (s.samples.length && tSec - s.samples[0][0] > 12) s.samples.shift();
      const turned = ((track - s.trackRef + 540) % 360) - 180;
      const settled = Math.abs(((track - s.samples[0][1] + 540) % 360) - 180) < 3 && tSec - s.samples[0][0] > 8;
      if (settled && Math.abs(turned) > 30) {
        const hdg = String((Math.round(track / 5) * 5) % 360 || 360).padStart(3, "0");
        const dir = turned > 0 ? "right" : "left";
        if (alt < 20000) {
          push("radio", 3, "A vector: the controller is steering it by compass heading, to line it up with the runway or to keep it clear of another aircraft.", [
            ctl("APPROACH", `turn ${dir} heading ${hdg}`, `turn ${dir} heading ${spell(hdg)}`),
            plt(`${dir[0].toUpperCase() + dir.slice(1)} heading ${hdg}`, `${dir} heading ${spell(hdg)}`),
          ]);
        }
        s.trackRef = track;
      } else if (settled && Math.abs(turned) < 8) {
        s.trackRef = track;
      }

      if (destKm != null && destKm < 30 && phase === "descend") {
        if (agl < 4500 && !s.said.has("seats")) {
          s.said.add("seats");
          push("cabin", 4, "The cabin lights are dimmed. The crew strap into their jump seats and silently rehearse the first thirty seconds of an evacuation — every landing, without exception.", [
            ["CAPTAIN", "Cabin crew, seats for landing.", "Cabin crew, seats for landing.", 0.96],
          ]);
        }
        if (agl < 2600 && !s.said.has("land")) {
          s.said.add("land");
          const rw = String(Math.round(track / 10) % 36 || 36).padStart(2, "0");
          const wd = String((Math.round(o.windDir / 10) * 10) % 360 || 360).padStart(3, "0");
          const kt = Math.max(2, Math.round(o.windKmh / 1.852));
          push("radio", 5, `The last instruction of the flight. The runway's number is simply its compass heading with the final digit dropped: it is landing toward ${Math.round(track / 10) * 10}°.`, [
            ctl("TOWER", `wind ${wd} degrees ${kt} knots, runway ${rw}, cleared to land`, `wind ${spell(wd)} degrees ${spell(String(kt))} knots, runway ${spell(rw)}, cleared to land`),
            plt(`Cleared to land runway ${rw}`, `Cleared to land runway ${spell(rw)}`),
          ]);
        }
      }
      if (origKm != null && origKm < 30 && phase === "climb" && agl < 6000 && agl > 800 && !s.said.has("dep")) {
        s.said.add("dep");
        push("radio", 4, "Just airborne. Its first call after take-off is to the departure controller, giving the height it is passing so the radar's reading can be checked.", [
          ["PILOT", `Departure, ${cs.show}, passing ${lv.show}, climbing`, `Departure, ${cs.say}, passing ${lv.say}, climbing`, 1.07],
          ctl("DEPARTURE", "identified", "identified"),
        ]);
      }
      s.alt = alt;
    }
    for (const hex of this.st.keys()) if (!live.has(hex)) this.st.delete(hex);
    this.queue = this.queue.filter((c) => tSec - c.at < 25).slice(-12);
  }

  /** The most worthwhile pending exchange, at a gentle pace. */
  take(tSec: number, focusHex: string, onScreen: Set<string>, gapSec = 34): RadioCall | null {
    if (tSec - this.lastEmit < gapSec || !this.queue.length) return null;
    const score = (c: RadioCall) => c.pri + (c.hex === focusHex ? 2 : 0) + (onScreen.has(c.hex) ? 1 : 0);
    this.queue.sort((a, b) => score(b) - score(a));
    const best = this.queue.shift()!;
    this.lastEmit = tSec;
    return best;
  }
}
