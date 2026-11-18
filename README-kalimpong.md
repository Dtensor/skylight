# 🛩️ Skylight (Kalimpong build) — Explained Like You're 10

> This is the *plain-words* guide to **this** Skylight setup (Kalimpong, no radio,
> free internet plane data). For the full technical README see [`README.md`](README.md).
> Every section stands alone — skip to whatever you need.

## 1) 🧸 What we built (the simple idea)

You know how planes fly way up in the sky, and you can sometimes hear them but barely
see them?

We built a **magic window in your ceiling**. 🪄 Point a projector up at the roof, turn
off the lights, and the real planes flying over **Kalimpong** show up as glowing little
aircraft gliding across your ceiling — at the *same time* they're really up there. Each
one has a tiny name tag: which airline, what kind of plane, and where it's going. ✈️➡️🏙️

Behind the planes we draw the **real sky** — the Sun ☀️, the Moon 🌙, the stars ⭐, and
the **Space Station** 🛰️ — all in the exact right spots for where you live.

The clever part: most people need a special radio antenna to catch the planes.
**You don't.** We grab the plane info for free from the internet instead. 🌐

## 2) 🙌 How YOU use it (do these by hand)

- 🖥️ **See the planes (ceiling picture):** open `http://localhost:21260/`
- 📱 **Change stuff from your phone:** open `http://192.168.0.109:21260/control`
  (sliders for stars, Moon, how far out to look, colors; tap **"ISS → jump"** to
  preview when the Space Station flies over)
- 📋 **Check it's awake:** `pm2 status` → find `skylight`, should say **online** in green
- 🔄 **Wake it up / fix a hiccup:** `pm2 restart skylight`

## 3) 🤖 What runs by itself (you do nothing!)

- 🔁 **Always-on:** **PM2** keeps Skylight running and brings it back after a crash or reboot.
- ✈️ **Catches planes every second:** asks a free plane-tracker about once a second; if
  it's down, it **auto-tries two backups** (airplanes.live → adsb.lol → adsb.fi) 🛟
- 🛰️ **Keeps the Space Station accurate:** every 6 hours it refreshes the ISS's path.
- 🌗 **Draws the real sky live:** Sun, Moon, and stars move to their true positions automatically.
- 💾 **Remembers your settings:** phone changes stick, even after a restart.

**Why it helps:** set it up *once*, and it just keeps being a working window to the sky. 🌌

## 4) 📊 Quick table

| Command / Link | What It Does | When I Use It |
|---|---|---|
| `http://localhost:21260/` 🖥️ | Shows the ceiling sky-window | When I want to watch planes |
| `http://192.168.0.109:21260/control` 📱 | Phone remote: toggles & sliders | When I want to change how it looks |
| `pm2 status` 📋 | Checks if Skylight is awake | When something seems off |
| `pm2 restart skylight` 🔄 | Restarts it fresh | If it's frozen or acting weird |
| `pm2 logs skylight` 📜 | Shows what it's doing/saying | When I'm curious or hunting a bug |

## 5) 🌟 A real evening with it

It's **9 PM in Kalimpong**. 🌙 You dim the lights and point the projector at the ceiling.

You open **`localhost:8771`** — the ceiling fills with black sky, a few stars, and the
Moon in its real spot. A glowing plane drifts across labeled *"→ New Delhi, 84 mi to go."* 🛫

You grab your phone, open the **control page**, and see a chip:
**"ISS in 2h 21m · max 13° · 3m → jump."** Low pass (13°) — not a great one tonight, so
you don't wait up. 😴

Overnight the Mac reboots for an update — but by morning Skylight is **already back on**,
because PM2 restarted it for you. You never lifted a finger. ✅

---

That's the whole thing: **a self-running window to the real sky over Kalimpong.** 🪟✨

---

### 🔧 Tiny cheat-sheet for grown-ups

- **Center:** Kalimpong (27.066, 88.4685), radius **150 mi** (Himalayan airspace is sparse —
  shrink it from the phone for the true "directly overhead" feel).
- **Airports drawn:** Bagdogra (IXB/VEBD) + Paro (PBH/VQPR).
- **Data:** free re-api failover chain; **no RTL-SDR needed** (`DATA_SOURCE=api`).
- **Satellites:** ISS only, from `wheretheiss.at` (celestrak.org is blocked on this network).
- **Service:** PM2 app `skylight` on port **8771** (`ecosystem.config.cjs`).


## 🪟 Sky Window: the front-wall view (added 2026-11-18)

### What we built
The ceiling view is a map you lie under. The **Sky Window** is the opposite: the front
wall becomes an opening in the house. You stand in Kalimpong and look up and out. The
planes are little 3D aircraft with contrails by day and red, green and white lights by
night. The mountains along the bottom are the real skyline, worked out from elevation
data, so Kangchenjunga sits where it really is. The sun, moon, stars, planets and
satellites are in their true places for this minute. Dark conifers stand close by, and
planes pass behind them, which is what makes the sky feel far away.

### How you use it
- **On this Mac:** open `http://localhost:21260/wall`
- **On the projector:** `~/claude_workspace/tools/parda/.venv/bin/python scripts/wall-on.py`
  (`--status` only looks, `--off` goes back to HDMI). It will not take the wall while
  something else is showing unless you add `--force`.
- **Aim it from the phone:** `http://192.168.0.109:21260/control`, section
  **Sky window (front wall)**: which way the wall faces, tilt, zoom, slow pan, labels,
  clouds, trees.
- **Keys** (keyboard on the display machine): arrows turn and tilt, `+ -` zoom,
  `c` true geometry, `[ ]` distance squeeze, `p` slow pan, `l` labels,
  `g` shadowed satellites, `k` clouds, `f` trees, `h` info line.
- **Try a look without saving it:** add `?heading=340&pitch=20&t=180&cloud=40` to the
  address (`t` = minutes from now).

### What is real and what is helped
| Thing | Real? |
|---|---|
| Which planes, their direction from you, height, heading, climb or descent | Real, live (about 1 s old) |
| How far away the planes look | **Squeezed ÷10.** Real traffic here is 100 to 450 km off and would sit 0 to 5° above the horizon. Press `c` for true geometry. |
| Plane size | Enlarged so you can see the shape |
| Sun, moon and phase, stars, planets, satellites | Real positions. A satellite glows only when it is in sunlight and your sky is dark; the others are faint markers |
| Mountain skyline | Real, from elevation tiles for the configured spot |
| Clouds | Real amount and wind direction (open-meteo); the shapes are drawn |
| Trees | Decoration, for depth |

### What runs by itself
- PM2 app `skylight` on port **21260** (port registry `skylight/ui`; the old 8771 belongs to something else now).
- Planes: adsb.fi / adsb.lol / airplanes.live, tried in turn every second.
- Satellites: CelesTrak "stations" + "visual" lists (about 166), refreshed every 6 hours.
- Weather every 15 minutes. Elevation tiles are fetched once and kept in `server/data/terrain/`.

### Gotchas
- The skyline is computed for the exact latitude and longitude in the config. A generic
  town coordinate can put a hill in front of you that your real house does not have. Set the
  real spot (control panel or `POST /api/config` with `centerLat`, `centerLon`).
- The projector's browser is an old Chrome 66 WebView. The build targets it
  (`target: "chrome66"` in `web/vite.config.ts`, three.js pinned to 0.152); keep both.
- PM2 must start the server as `node --import tsx` directly. Through the pnpm wrapper every
  outgoing request failed with `ENOTFOUND`.
- Screenshots for checking: `node scripts/wall-shot.mjs docs/wall "t=0" "t=240&heading=120"`.

## Sky Window as an app, with sound (added 2026-11-18)

The front wall no longer runs in the projector's browser. `android/` holds a tiny
app (one fullscreen WebView: no bars, screen kept awake, sound allowed to start
by itself). Build it with `android/build.sh` (needs JDK 17, Android build-tools
34.0.0 and platform 28 under `~/Library/Android/sdk`); output is
`android/out/skywindow.apk`.

```
PY=/Users/King_1/claude_workspace/tools/parda/.venv/bin/python
$PY scripts/wall-on.py                 # show the sky (installs the app if missing)
$PY scripts/wall-on.py --install       # reinstall after rebuilding the app
$PY scripts/wall-on.py --place delhi   # stand in Green Park, Delhi (also moves the ceiling view)
$PY scripts/wall-on.py --place kalimpong
$PY scripts/wall-on.py --off           # back to the HDMI viewer
```

What is real and what is ambience:

- Real: aircraft positions, types, routes, liveries by airline; sun, moon, planets,
  stars, Milky Way position; satellites; the skyline; cloud cover and wind.
- Ambience (simulated): meteors, birds and the owl, the lamps on the hills (seeded
  clusters, not surveyed buildings), and every sound. Aircraft rumble follows the
  same distance compression as the picture; real jets that far away are silent.

Keys on the wall page: `m` sound, `s` close-up panel, `i` right-now notes (plus the
earlier ones). The same switches and a volume slider are in `/control`.
The page adapts to the display: it drops resolution if it measures under 22 fps.

Satellites: CelesTrak blocks callers who ask too often, so `server/src/tle.ts`
also asks a second supplier and a refresh can only add or update, never shrink.

## Lie down anywhere, and sit in four seats

```
PY=/Users/King_1/claude_workspace/tools/parda/.venv/bin/python
$PY scripts/wall-on.py --place "Reykjavik"     # any place name on Earth
$PY scripts/wall-on.py --place "35.55,139.78"  # or latitude,longitude
$PY scripts/wall-on.py --place kalimpong       # home (presets: kalimpong, delhi)
```

A name is looked up (open-meteo geocoding, no key), the wall is moved there, and
the distance scaling is chosen from the traffic actually found: busy sky = true
geometry at 90 nm, empty sky = 250 nm squeezed ÷10. The bottom line shows the
place and its own local clock. Pine silhouettes appear only above 900 m.

What is on the wall, and how true each part is:

| Part | Where it comes from |
|---|---|
| Aircraft, heights, speeds, routes | Live (airplanes.live, adsb.lol, adsb.fi) |
| **On the radio** (bottom left, green) | *Rebuilt*, not recorded. Each exchange is triggered by something the aircraft measurably did (left its level, levelled off, turned, changed radar code, came down final approach) and uses only observed numbers, in standard radio wording. Spoken by this Mac's own voice through a radio filter. |
| **In the cabin** (bottom left, amber) | The customary announcement for that moment (seatbelt sign off at 10,000 ft, "prepare the cabin for landing", "seats for landing"), with a two-note chime. |
| **Four seats** (top left) | Window seat, cabin crew, flight deck, radar room: what customarily happens at this phase of this flight. Phase comes from live height, climb/descent and distance to each end of the route. Scenes are written, not reported. |
| **Our sky remembers** | Only what this server has itself seen: each aircraft and flight, per place, per day (`server/data/sightings.json`). Starts empty on 18 Nov 2026 and grows; "regular" lines need 3+ days. |
| **Waiting at the other end / the wind it is in** | Live weather and local time at the destination, and the 250 hPa wind at the aircraft (open-meteo). |
| State of the routes, who is flying, lore | Written from general knowledge, dated where the fact has a date. Not fetched tonight, not source-checked line by line. |

Not available, by choice or by fact:

- **Real ATC audio.** LiveATC forbids third-party use of its streams, and no other
  permitted live source was found, so every place gets the rebuilt radio.
- **Who the pilots are.** Crew names are not public. The "who is flying" lines
  say what is true of any airline crew instead.
- **Per-airframe history** (age, past owners). The free lookups tried returned
  nothing useful; the sky's own memory fills this in over time.

Keys on the wall: `r` radio and cabin on/off, `v` spoken voice on/off (also on
the control page). Server endpoints: `/api/say?t=`, `/api/seen?hex=&flight=`,
`/api/point?lat=&lon=`.
