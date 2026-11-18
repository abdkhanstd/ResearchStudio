/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
// PM2: pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'research-studio',
    script: 'server.js',
    cwd: __dirname,
    max_memory_restart: '600M',
    kill_timeout: 5000,
    env: { NODE_ENV: 'production' },
  }],
};
