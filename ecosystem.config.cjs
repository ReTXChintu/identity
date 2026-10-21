// PM2 process definition for the identity server.
//
//   npm ci && npm run build
//   pm2 start ecosystem.config.cjs     # first time
//   pm2 restart identity               # after a deploy or an .env edit
//   pm2 save                           # survive a reboot
//
// Configuration lives in .env next to this file, which the server reads
// itself on every start. Nothing is injected here on purpose: PM2 caches a
// process's environment, so injected values go stale until a restart with
// --update-env. PORT comes from .env too (default 50011).
module.exports = {
  apps: [
    {
      name: "identity",
      script: "dist/index.js",
      cwd: __dirname,
      // In-memory rate limits assume a single process.
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "300M",
      time: true,
    },
  ],
};
