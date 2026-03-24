const { spawn } = require('child_process');
const path = require('path');

function start() {
  console.log('[LAUNCHER] Starting server...');
  const child = spawn('node', [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code) => {
    console.log(`[LAUNCHER] Server exited with code ${code}. Restarting in 5s...`);
    setTimeout(start, 5000);
  });
}

start();
