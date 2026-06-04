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

- 🖥️ **See the planes (ceiling picture):** open `http://localhost:8771/`
- 📱 **Change stuff from your phone:** open `http://192.168.0.105:8771/control`
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
| `http://localhost:8771/` 🖥️ | Shows the ceiling sky-window | When I want to watch planes |
| `http://192.168.0.105:8771/control` 📱 | Phone remote: toggles & sliders | When I want to change how it looks |
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
