const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

function waitForPortOpen(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch (_) {
        // ignore
      }
      resolve(false);
    }, timeoutMs);
    socket
      .once('connect', () => {
        clearTimeout(timer);
        try {
          socket.destroy();
        } catch (_) {
          // ignore
        }
        resolve(true);
      })
      .once('error', () => {
        clearTimeout(timer);
        resolve(false);
      })
      .connect(port, host);
  });
}

async function ensureCollabServer() {
  const host = process.env.YJS_HOST || 'localhost';
  const port = Number(process.env.YJS_PORT) || 1234;

  const alreadyUp = await waitForPortOpen(host, port, 120);
  if (alreadyUp) return;

  // Start y-websocket server (CRDT transport) in background.
  // Uses @y/websocket-server bin implementation.
  const serverPath = path.join(
    __dirname,
    'node_modules',
    '@y',
    'websocket-server',
    'src',
    'server.js',
  );

  spawn(process.execPath, [serverPath], {
    env: { ...process.env, HOST: host, PORT: String(port) },
    stdio: 'ignore',
    detached: true,
  }).unref();
}

ensureCollabServer()
  .catch((e) => {
    // Collab is optional for running sandbox.
    console.error('Failed to start collab server:', e);
  })
  .finally(() => {
    require('./src/server');
  });
