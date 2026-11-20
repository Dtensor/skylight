// Entry point. Wires the config store, data poller, WebSocket hub, REST API,
// and (in production) serves the built web app. Binds 0.0.0.0 so the control
// panel is reachable from your phone on the LAN.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import express from "express";
import type { DataSource } from "@shared/index.js";
import { ConfigStore } from "./config-store.js";
import { RouteEnricher } from "./enrich/routes.js";
import { Poller } from "./datasource.js";
import { Hub } from "./hub.js";
import { TleStore } from "./tle.js";
import { Memory } from "./memory.js";
import { ReplayStore } from "./replay.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Override for throwaway test instances, so they never share the live
// display's config.json / replay.json / sightings.json.
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(__dirname, "../data");
const WEB_DIST = resolve(__dirname, "../../web/dist");

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const SOURCE = (process.env.DATA_SOURCE as DataSource) ?? "radio";
const RADIO_URL =
  process.env.AIRCRAFT_JSON_URL ?? "http://localhost:8080/data/aircraft.json";
// Ordered re-api failover chain. Override with a comma-separated API_URL.
// All three speak the same /v2/point/{lat}/{lon}/{r} schema (radius in NM).
const DEFAULT_API_URLS = [
  "https://api.airplanes.live/v2/point/{lat}/{lon}/{r}",
  "https://api.adsb.lol/v2/point/{lat}/{lon}/{r}",
  "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{r}",
];
const API_URLS = (process.env.API_URL
  ? process.env.API_URL.split(",")
  : DEFAULT_API_URLS
)
  .map((s) => s.trim())
  .filter(Boolean);
const POLL_MS = Number(process.env.POLL_MS ?? 1000);
const ROUTE_CACHE_HOURS = Number(process.env.ROUTE_CACHE_HOURS ?? 12);
// When on radio, also poll the API and merge (keeps landing aircraft alive).
const SUPPLEMENT_API = (process.env.SUPPLEMENT_API ?? "1") !== "0";
const API_POLL_MS = Number(process.env.API_POLL_MS ?? 4000);

async function main(): Promise<void> {
  const store = new ConfigStore(resolve(DATA_DIR, "config.json"));
  await store.load();

  const enricher = new RouteEnricher(
    resolve(DATA_DIR, "route-cache.json"),
    ROUTE_CACHE_HOURS,
  );
  await enricher.load();

  const tleStore = new TleStore(resolve(DATA_DIR, "tle-cache.json"));
  await tleStore.load();

  // Recent traffic, kept for labelled replay when the sky goes quiet.
  const replay = new ReplayStore(
    resolve(DATA_DIR, "replay.json"),
    Number(process.env.REPLAY_EVERY_MS ?? 3000),
    Number(process.env.REPLAY_FRAMES ?? 600),
  );
  await replay.load();
  setInterval(() => void replay.save().catch((e) => console.error("[replay] save:", e)), 5 * 60_000).unref?.();

  const app = express();
  app.use(express.json());

  const server = createServer(app);
  const hub = new Hub(server, {
    store,
    getSnapshot: () => poller.getSnapshot(),
    getStatus: () => poller.getStatus(),
  });

  const poller = new Poller({
    source: SOURCE,
    radioUrl: RADIO_URL,
    apiUrlTemplates: API_URLS,
    pollMs: POLL_MS,
    supplementApi: SUPPLEMENT_API,
    apiPollMs: API_POLL_MS,
    getConfig: () => store.get(),
    enricher,
    onSnapshot: (now, aircraft) => hub.broadcastAircraft(now, aircraft),
    onStatus: (status) => hub.broadcastStatus(status),
    replay,
  });

  // The sky's memory: note who is overhead once a minute.
  const memory = new Memory(resolve(DATA_DIR, "sightings.json"));
  await memory.load();
  setInterval(() => {
    const c = store.get();
    memory.note(c.centerLat, c.centerLon, poller.getLiveSnapshot().aircraft);
  }, 60_000).unref?.();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void Promise.allSettled([memory.save(), replay.save()]).then(() => process.exit(0)));

  app.get("/api/seen", (req, res) => {
    const c = store.get();
    res.json(memory.get(c.centerLat, c.centerLon, String(req.query.hex ?? "").slice(0, 8), String(req.query.flight ?? "").slice(0, 10)));
  });

  // Conditions at any point on Earth right now: local clock, ground weather,
  // and the wind at cruising height (250 hPa, about 10.5 km). open-meteo, keyless.
  const points = new Map<string, { at: number; body: unknown }>();
  app.get("/api/point", async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return res.status(400).json({ error: "bad coordinates" });
    }
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const hit = points.get(key);
    if (hit && Date.now() - hit.at < 20 * 60_000) return res.json(hit.body);
    try {
      const r = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
          "&current=temperature_2m,weather_code,wind_speed_10m,wind_speed_250hPa,wind_direction_250hPa&timezone=auto",
        { signal: AbortSignal.timeout(30000) },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { current?: Record<string, unknown>; timezone?: string };
      const body = { ...(j.current ?? {}), timezone: j.timezone };
      if (points.size > 400) points.clear();
      points.set(key, { at: Date.now(), body });
      res.json(body);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "unavailable" });
    }
  });

  // Speech for the reconstructed radio calls and cabin announcements, made on
  // this Mac: AudioSmith's local voices (loopback API) when the app is running,
  // the system voice otherwise. Text is restricted to plain words.
  const SAY_DIR = resolve(DATA_DIR, "say");
  const AUDIOSMITH = process.env.AUDIOSMITH_URL ?? "http://127.0.0.1:20711";
  const VOICES = new Set(["am_adam", "am_michael", "am_puck", "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "bm_george", "bm_lewis", "bf_emma", "bf_isabella"]);
  // Voices designed in AudioSmith for this wall: slower to make (several
  // seconds a line) but with a character the stock voices lack.
  const DESIGNED: Record<string, { model: string; voice: string }> = {
    gruff: { model: "qwen3-tts-1.7b-voicedesign-4bit", voice: "01M7QZTH195QGC0P8AHX9AP3F5" }, // "Delhi Control Gruff"
  };
  /** A streamed WAV may carry placeholder lengths; old browsers need the real ones. */
  const fixWav = (buf: Buffer): Buffer => {
    const at = buf.indexOf("data", 12, "latin1");
    if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF" || at < 0) return buf;
    buf.writeUInt32LE(buf.length - 8, 4);
    buf.writeUInt32LE(buf.length - at - 8, at + 4);
    return buf;
  };
  app.get("/api/say", async (req, res) => {
    const text = String(req.query.t ?? "");
    const voice = String(req.query.v ?? "");
    const fast = req.query.fast === "1";
    if (!/^[A-Za-z0-9 ,.'-]{1,240}$/.test(text)) return res.status(400).json({ error: "bad text" });
    if (voice && !VOICES.has(voice) && !DESIGNED[voice]) return res.status(400).json({ error: "unknown voice" });
    const name = (v: string) => resolve(SAY_DIR, createHash("sha1").update(`${v}|${fast ? 1 : 0}|${text}`).digest("hex") + ".wav");
    let file = name(voice);
    if (!existsSync(file)) {
      await mkdir(SAY_DIR, { recursive: true });
      let made = false;
      if (voice) {
        try {
          const r = await fetch(`${AUDIOSMITH}/v1/audio/speech`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-AudioSmith-Request": "1" },
            body: JSON.stringify(
              DESIGNED[voice]
                ? { ...DESIGNED[voice], input: text, response_format: "wav" }
                : { model: "kokoro-82m-bf16", voice, input: text, response_format: "wav", speed: fast ? 1.14 : 0.98 },
            ),
            signal: AbortSignal.timeout(60000),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          await writeFile(file, fixWav(Buffer.from(await r.arrayBuffer())));
          made = true;
        } catch (err) {
          console.error("[say] AudioSmith unavailable, using the system voice:", err instanceof Error ? err.message : err);
        }
      }
      if (!made) {
        file = name("");
        if (!existsSync(file)) {
          const ok = await new Promise<boolean>((done) => {
            execFile("/usr/bin/say", ["-o", file, "--data-format=LEI16@16000", "-r", "188", text], { timeout: 30000 }, (err) => done(!err));
          });
          if (!ok) return res.status(503).json({ error: "speech unavailable on this host" });
        }
      }
    }
    res.set("Cache-Control", "public, max-age=604800");
    res.sendFile(file);
  });

  // --- REST API (handy for debugging + non-WS clients) ---
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/config", (_req, res) => res.json(store.get()));
  app.post("/api/config", (req, res) => res.json(store.patch(req.body)));
  app.post("/api/config/reset", (_req, res) => res.json(store.reset()));
  app.get("/api/aircraft", (_req, res) => res.json(poller.getSnapshot()));
  app.get("/api/status", (_req, res) => res.json(poller.getStatus()));
  app.get("/api/tle", async (_req, res) => res.json(await tleStore.get()));
  // Terrain tiles (AWS Terrarium, keyless) for the wall view's real skyline.
  // Proxied + cached on disk so the display device needs only this server.
  app.get("/api/terrain/:z/:x/:y", async (req, res) => {
    const [z, x, y] = [req.params.z, req.params.x, req.params.y].map(Number);
    const ok =
      [z, x, y].every((n) => Number.isInteger(n) && n >= 0) &&
      z >= 6 && z <= 12 && x < 2 ** z && y < 2 ** z;
    if (!ok) return res.status(400).json({ error: "bad tile" });
    const file = resolve(DATA_DIR, "terrain", `${z}-${x}-${y}.png`);
    try {
      if (!existsSync(file)) {
        const r = await fetch(
          `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
          { signal: AbortSignal.timeout(30000) },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, Buffer.from(await r.arrayBuffer()));
      }
      res.set("Cache-Control", "public, max-age=2592000").sendFile(file);
    } catch (err) {
      const cause = err instanceof Error ? (err.cause as { code?: string } | undefined)?.code : undefined;
      res.status(502).json({ error: err instanceof Error ? err.message : "fetch failed", cause });
    }
  });

  // Current cloud cover + wind for the wall's cloud layer (open-meteo, keyless).
  let wx: { at: number; body: unknown; key: string } | null = null;
  app.get("/api/weather", async (_req, res) => {
    const c = store.get();
    const key = `${c.centerLat},${c.centerLon}`;
    if (wx && wx.key !== key) wx = null; // we have moved: yesterday's sky is someone else's
    if (!wx || Date.now() - wx.at > 15 * 60_000) {
      try {
        const r = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${c.centerLat}&longitude=${c.centerLon}` +
            "&current=cloud_cover,wind_speed_10m,wind_direction_10m,temperature_2m",
          { signal: AbortSignal.timeout(30000) },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        wx = { at: Date.now(), key, body: ((await r.json()) as { current?: unknown }).current ?? {} };
      } catch (err) {
        console.error("[weather]", err instanceof Error ? err.message : err);
        if (!wx) return res.status(502).json({ error: "weather unavailable" });
      }
    }
    res.json(wx!.body);
  });

  // Nearest-airport METAR (aviationweather.gov, keyless). Pilots' weather:
  // wind, visibility, cloud bases, QNH and flight category. Cached 5 minutes;
  // the observation time is passed through so clients can mark it stale.
  const metars = new Map<string, { at: number; body: unknown }>();
  app.get("/api/metar", async (req, res) => {
    const id = String(req.query.id ?? store.get().metarStation ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{3}$/.test(id)) return res.status(400).json({ error: "station must be a 4-letter ICAO code" });
    const hit = metars.get(id);
    if (hit && Date.now() - hit.at < 5 * 60_000) return res.json(hit.body);
    try {
      const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${id}&format=json`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = (await r.json()) as Array<Record<string, unknown>>;
      const m = Array.isArray(list) ? list[0] : undefined;
      if (!m) return res.status(404).json({ error: `no METAR for ${id}` });
      const body = {
        station: id,
        name: m.name,
        raw: m.rawOb,
        observedAt: typeof m.obsTime === "number" ? m.obsTime * 1000 : null,
        windDir: m.wdir,
        windKt: m.wspd,
        gustKt: m.wgst ?? null,
        visibilitySm: m.visib,
        tempC: m.temp,
        dewC: m.dewp,
        qnhHpa: m.altim,
        clouds: Array.isArray(m.clouds) ? m.clouds : [],
        category: m.fltCat ?? null,
      };
      if (metars.size > 50) metars.clear();
      metars.set(id, { at: Date.now(), body });
      res.json(body);
    } catch (err) {
      console.error("[metar]", err instanceof Error ? err.message : err);
      if (hit) return res.json(hit.body); // last good beats nothing; client ages it
      res.status(502).json({ error: "metar unavailable" });
    }
  });

  // Preview the quiet-sky replay on demand (e.g. to see it on the ceiling at
  // your own location). In memory only; ends by itself. seconds: 5..600, 0 stops.
  app.post("/api/replay/preview", (req, res) => {
    const sec = Number(req.body?.seconds ?? 60);
    if (!Number.isFinite(sec) || sec < 0 || sec > 600) return res.status(400).json({ error: "seconds must be 0..600" });
    if (sec > 0 && replay.size < 2) return res.status(409).json({ error: "nothing recorded yet" });
    poller.previewReplay(sec * 1000);
    res.json({ previewUntil: sec ? Date.now() + sec * 1000 : null, frames: replay.size });
  });

  app.post("/api/source", (req, res) => {
    const s = req.body?.source;
    if (s !== "radio" && s !== "api") {
      return res.status(400).json({ error: "source must be 'radio' or 'api'" });
    }
    poller.setSource(s);
    res.json(poller.getStatus());
  });

  // --- static web (production build) ---
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get("/control", (_req, res) => res.sendFile(resolve(WEB_DIST, "control.html")));
    app.get("/wall", (_req, res) => res.sendFile(resolve(WEB_DIST, "wall.html")));
    app.get("/", (_req, res) => res.sendFile(resolve(WEB_DIST, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res
        .type("text/plain")
        .send("Web build not found. Run `npm run build`, or use the Vite dev server."),
    );
  }

  poller.start();

  server.listen(PORT, HOST, () => {
    console.log(`[server] listening on http://${HOST}:${PORT}`);
    console.log(`[server] data source: ${SOURCE} (${SOURCE === "radio" ? RADIO_URL : API_URLS.join(" → ")})`);
    console.log(`[server] control panel: http://<this-host>:${PORT}/control`);
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
