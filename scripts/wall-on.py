#!/usr/bin/env python3.11
"""Put the Skylight sky window on the family-room projector, or take it off.

Run with parda's interpreter (it has adb_shell and the projector's ADB key):

    ~/claude_workspace/tools/parda/.venv/bin/python scripts/wall-on.py            # show
    ~/claude_workspace/tools/parda/.venv/bin/python scripts/wall-on.py --status   # look only
    ~/claude_workspace/tools/parda/.venv/bin/python scripts/wall-on.py --off      # back to HDMI
    ~/claude_workspace/tools/parda/.venv/bin/python scripts/wall-on.py --place "Reykjavik"   # lie down anywhere

It refuses to take the wall while another app or an HDMI source is in front,
unless --force is given: somebody may be watching.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import socket
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from adb_shell.adb_device import AdbDeviceTcp
from adb_shell.auth.sign_pythonrsa import PythonRSASigner

PROJECTOR = "100.111.119.103"  # tailnet name casiris; its LAN address moves with DHCP
BROWSER = "com.android.browser"
APP = "com.skylight.wall"  # our fullscreen app (android/build.sh)
APK = Path(__file__).resolve().parent.parent / "android" / "out" / "skywindow.apk"
TV_INPUT = "com.mediatek.wwtv.tvcenter"  # the HDMI / TV viewer
IDLE_APPS = ("launcher", "kingboard", BROWSER, APP)
PORT = 21260  # port registry: skylight/ui

# Where "you are standing". Near a big airport the traffic is close, so little
# or no distance compression is needed; in the hills it is far away. Any other
# name is looked up (open-meteo geocoding, keyless) and the scaling is chosen
# from the traffic actually found there.
PLACES = {
    "kalimpong": {
        "centerLat": 27.066,
        "centerLon": 88.4685,
        "wallCompress": 10,
        "wallRangeNm": 250,
        "wallPlaceName": "Kalimpong",
        "wallForeground": True,
    },
    "delhi": {  # Green Park
        "centerLat": 28.559,
        "centerLon": 77.207,
        "wallCompress": 2,
        "wallRangeNm": 90,
        "wallPlaceName": "Green Park, Delhi",
        "wallForeground": False,
    },
}
API = f"http://127.0.0.1:{PORT}/api"


def _json(url: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "User-Agent": "sky-window"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    a = (
        math.sin(math.radians(lat2 - lat1) / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 2 * 6371 * math.asin(math.sqrt(a))


def find_place(name: str) -> dict | None:
    """Coordinates of any named place on Earth, or "lat,lon" given directly."""
    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*", name)
    if m:
        lat, lon = float(m.group(1)), float(m.group(2))
        if abs(lat) > 90 or abs(lon) > 180:
            return None
        return {"name": f"{lat:.2f}, {lon:.2f}", "latitude": lat, "longitude": lon, "elevation": 0}
    q = urllib.parse.urlencode({"name": name, "count": 1, "language": "en", "format": "json"})
    hits = _json(f"https://geocoding-api.open-meteo.com/v1/search?{q}").get("results") or []
    return hits[0] if hits else None


def set_place(name: str) -> bool:
    preset = PLACES.get(name.strip().lower())
    if preset:
        c = _json(f"{API}/config", preset)
    else:
        hit = find_place(name)
        if not hit:
            print(f'Could not find a place called {name!r}. Try a city name, or "lat,lon".')
            return False
        lat, lon = round(hit["latitude"], 4), round(hit["longitude"], 4)
        label = ", ".join(x for x in (hit.get("name"), hit.get("country")) if x)
        # Look wide first, then pull in if the sky nearby is busy.
        _json(
            f"{API}/config",
            {
                "centerLat": lat,
                "centerLon": lon,
                "wallPlaceName": label,
                "wallRangeNm": 250,
                "wallCompress": 10,
                "wallForeground": (hit.get("elevation") or 0) > 900,  # the pine silhouettes belong to hill country
            },
        )
        near: list[float] = []
        for _ in range(6):
            time.sleep(5)
            snap = _json(f"{API}/aircraft").get("aircraft", [])
            near = sorted(_km(lat, lon, a["lat"], a["lon"]) for a in snap if a.get("lat") is not None)
            if near:
                break
        busy = sum(1 for d in near if d < 167)  # within 90 nautical miles
        if busy >= 12:
            fifth = near[4]
            tune = {"wallRangeNm": 90, "wallCompress": 1 if fifth < 25 else 2 if fifth < 60 else 4}
        elif busy >= 4:
            tune = {"wallRangeNm": 150, "wallCompress": 6}
        else:
            tune = {"wallRangeNm": 250, "wallCompress": 10}
        c = _json(f"{API}/config", tune)
        print(f"found {label}: {len(near)} aircraft within 460 km, {busy} within 170 km")
    print(
        f"place: {c['wallPlaceName']} ({c['centerLat']}, {c['centerLon']}), "
        f"range {c['wallRangeNm']} nm, aircraft distance ÷{c['wallCompress']}"
    )
    return True


def my_ip() -> str:
    """This Mac's address as the projector can reach it: the tailnet one.

    The Mac roams between the house's two LANs (192.168.0.x and 192.168.1.x),
    so a LAN address is only right some of the time; the tailnet one always is.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((PROJECTOR, 9))
        return s.getsockname()[0]
    finally:
        s.close()


def device() -> AdbDeviceTcp:
    key = Path.home() / ".android" / "adbkey"
    pub = key.with_suffix(".pub")
    signer = PythonRSASigner(pub.read_text() if pub.exists() else "", key.read_text())
    dev = AdbDeviceTcp(PROJECTOR, 5555, default_transport_timeout_s=40)
    dev.connect(rsa_keys=[signer], auth_timeout_s=8)
    return dev


def foreground(dev: AdbDeviceTcp) -> str:
    out = dev.shell("dumpsys activity activities | grep mResumedActivity | head -1")
    parts = out.split()
    return next((p for p in parts if "/" in p), out.strip())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--off", action="store_true", help="return the projector to its HDMI viewer")
    ap.add_argument("--status", action="store_true", help="report what is in front; change nothing")
    ap.add_argument("--force", action="store_true", help="take the wall even if something is showing")
    ap.add_argument("--install", action="store_true", help="(re)install the projector app first")
    ap.add_argument("--place", help='lie down anywhere: a preset (kalimpong, delhi), any place name, or "lat,lon"')
    ap.add_argument("--query", default="", help="extra URL parameters, e.g. heading=340&pitch=20")
    args = ap.parse_args()

    dev = device()
    try:
        front = foreground(dev)
        print(f"in front: {front}")
        if args.status:
            return 0
        if args.off:
            print(
                dev.shell(
                    f"am force-stop {APP}; am force-stop {BROWSER}; monkey -p {TV_INPUT} -c android.intent.category.LAUNCHER 1"
                ).strip()[-160:]
            )
            print(f"now in front: {foreground(dev)}")
            return 0
        if not args.force and not any(a in front for a in IDLE_APPS):
            print("Something else is on the wall. Not taking it; pass --force once you know it is free.")
            return 2
        if args.place and not set_place(args.place):
            return 1
        url = f"http://{my_ip()}:{PORT}/wall" + (f"?{args.query}" if args.query else "")
        installed = APP in dev.shell(f"pm list packages {APP}")
        if args.install or not installed:
            if not APK.exists():
                print(f"No app build at {APK}; run android/build.sh first.")
                return 1
            dev.push(str(APK), "/data/local/tmp/skywindow.apk")
            print("install:", dev.shell("pm install -r /data/local/tmp/skywindow.apk").strip()[-120:])
        # Stop first so the app starts clean with the new address; the stock
        # browser is closed too, so it cannot sit behind with its bars.
        out = dev.shell(
            f"am force-stop {BROWSER}; am force-stop {APP}; am start -n {APP}/.MainActivity --es url '{url}'"
        )
        print(out.strip()[-200:])
        print(f"opened {url}\nnow in front: {foreground(dev)}")
        return 0 if "Error" not in out else 1
    finally:
        dev.close()


if __name__ == "__main__":
    sys.exit(main())
