// pm2 process config for the always-on LAN dashboard server.
// Usage:  npm i -g pm2  &&  npm run serve:start
// Reboot persistence:  pm2 startup   (run the printed command)  then  pm2 save
module.exports = {
  apps: [
    {
      name: "endurance-dashboard",
      script: "npm",
      args: "run serve",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      env: {
        COACH_PORT: "3000",
        COACH_HOST: "0.0.0.0", // bind to LAN so a phone on the same Wi-Fi can reach it
      },
    },
  ],
};
