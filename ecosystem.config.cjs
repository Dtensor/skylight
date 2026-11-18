// PM2 appliance config for Skylight (no-radio / free-API mode).
// Start:   pm2 start /Users/King_1/claude_workspace/skylight/ecosystem.config.cjs
// Logs:    pm2 logs skylight --lines 50
// Display: http://localhost:21260/   Wall: /wall   Control (phone): http://<lan-ip>:21260/control
module.exports = {
  apps: [
    {
      name: "skylight",
      // Launched as node + tsx directly: via the pnpm wrapper the server's DNS
      // lookups failed under PM2 (ENOTFOUND on every fetch), 2026-11-18.
      cwd: "/Users/King_1/claude_workspace/skylight/server",
      script: "src/index.ts",
      interpreter: "/Users/King_1/.hermes/node/bin/node",
      interpreter_args: "--import tsx",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        PATH: "/Users/King_1/bin:/Users/King_1/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        DATA_SOURCE: "api", // no RTL-SDR — pull from the free re-api failover chain
        SUPPLEMENT_API: "0", // only relevant in radio mode; off to avoid extra polls
        HOST: "0.0.0.0", // reachable from your phone on the LAN
        PORT: "21260", // port registry: skylight/ui (8771 is now owned elsewhere)
        // API_URL override is optional; default chain is
        // airplanes.live → adsb.lol → adsb.fi (set in server/src/index.ts).
        // TLE sources default to CelesTrak stations + visual, with
        // wheretheiss.at as an ISS-only fallback (see server/src/tle.ts).
      },
    },
  ],
};
