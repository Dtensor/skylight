#!/usr/bin/env python3.11
"""Put the Skylight sky window on the family-room projector, or take it off.

Run with parda's interpreter (it has adb_shell and the projector's ADB key):

    ~/claude_workspace/tools/parda/.venv/bin/python scripts/wall-on.py            # show
    ~/claude_workspace/tools/parda/.venv/bin/python scripts/wall-on.py --status   # look only
    ~/claude_workspace/tools/parda/.venv/bin/python scripts/wall-on.py --off      # back to HDMI

It refuses to take the wall while another app or an HDMI source is in front,
unless --force is given: somebody may be watching.
"""

from __future__ import annotations

import argparse
import socket
import sys
from pathlib import Path

from adb_shell.adb_device import AdbDeviceTcp
from adb_shell.auth.sign_pythonrsa import PythonRSASigner

PROJECTOR = "100.111.119.103"  # tailnet name casiris; its LAN address moves with DHCP
BROWSER = "com.android.browser"
TV_INPUT = "com.mediatek.wwtv.tvcenter"  # the HDMI / TV viewer
IDLE_APPS = ("launcher", "kingboard", BROWSER)
PORT = 21260  # port registry: skylight/ui


def lan_ip() -> str:
    """This Mac's address on the LAN the projector shares."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.168.0.1", 9))
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
                    f"am force-stop {BROWSER}; monkey -p {TV_INPUT} -c android.intent.category.LAUNCHER 1"
                ).strip()[-160:]
            )
            print(f"now in front: {foreground(dev)}")
            return 0
        if not args.force and not any(a in front for a in IDLE_APPS):
            print("Something else is on the wall. Not taking it; pass --force once you know it is free.")
            return 2
        url = f"http://{lan_ip()}:{PORT}/wall" + (f"?{args.query}" if args.query else "")
        # Stop first: a browser that is already running only comes to the front
        # and keeps its old page (learned on the previous projector).
        out = dev.shell(f"am force-stop {BROWSER}; am start -a android.intent.action.VIEW -d '{url}' -p {BROWSER}")
        print(out.strip()[-200:])
        print(f"opened {url}\nnow in front: {foreground(dev)}")
        return 0 if "Error" not in out else 1
    finally:
        dev.close()


if __name__ == "__main__":
    sys.exit(main())
