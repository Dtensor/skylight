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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
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
  let wx: { at: number; body: unknown } | null = null;
  app.get("/api/weather", async (_req, res) => {
    if (!wx || Date.now() - wx.at > 15 * 60_000) {
      const c = store.get();
      try {
        const r = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${c.centerLat}&longitude=${c.centerLon}` +
            "&current=cloud_cover,wind_speed_10m,wind_direction_10m,temperature_2m",
          { signal: AbortSignal.timeout(30000) },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        wx = { at: Date.now(), body: ((await r.json()) as { current?: unknown }).current ?? {} };
      } catch (err) {
        console.error("[weather]", err instanceof Error ? err.message : err);
        if (!wx) return res.status(502).json({ error: "weather unavailable" });
      }
    }
    res.json(wx!.body);
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
