// pm2 process config for the always-on LAN dashboard server.
// Usage:  npm i -g pm2  &&  npm run pm2:start
// Reboot persistence (one-time):  pm2 startup   (run the printed command)  then  pm2 save
// Auto-applies code changes: `watch` restarts the server when src/ changes (e.g. after a git pull).
module.exports = {
  apps: [
    {
      name: "endurance-dashboard",
      script: "npm",
      args: "run serve",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      // Restart automatically on a code change so `git pull` takes effect with no manual pm2 restart.
      watch: ["src", "ecosystem.config.cjs"],
      ignore_watch: ["node_modules", "data", "reports", "dist", ".git"],
      watch_delay: 2000, // debounce so a multi-file pull triggers a single restart
      env: {
        COACH_PORT: "3000",
        COACH_LAN: "1", // bind the LAN for phone access; all routes still require the pairing token
      },
    },
  ],
};
