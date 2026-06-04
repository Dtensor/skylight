// PM2 appliance config for Skylight (no-radio / free-API mode).
// Start:   pm2 start /Users/King_1/claude_workspace/skylight/ecosystem.config.cjs
// Logs:    pm2 logs skylight --lines 50
// Display: http://localhost:8771/   Control (phone): http://<lan-ip>:8771/control
module.exports = {
  apps: [
    {
      name: "skylight",
      cwd: "/Users/King_1/claude_workspace/skylight",
      script: "/opt/homebrew/bin/pnpm",
      args: "-F server start",
      interpreter: "none",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        DATA_SOURCE: "api", // no RTL-SDR — pull from the free re-api failover chain
        SUPPLEMENT_API: "0", // only relevant in radio mode; off to avoid extra polls
        HOST: "0.0.0.0", // reachable from your phone on the LAN
        PORT: "8771",
        // API_URL override is optional; default chain is
        // airplanes.live → adsb.lol → adsb.fi (set in server/src/index.ts).
        // celestrak.org (the default TLE source) is unreachable from this
        // network, so pull the ISS element set from wheretheiss.at instead —
        // same 3-line TLE format the parser expects. ISS-only (no faint sats),
        // which is all the ceiling needs. Cached to disk + refreshed every 6h.
        TLE_URL: "https://api.wheretheiss.at/v1/satellites/25544/tles?format=text",
      },
    },
  ],
};
