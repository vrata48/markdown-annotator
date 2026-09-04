/* Boots the relay locally with `wrangler dev` for tests. Shared by the relay
 * protocol test and the browser collaboration test. */
const { spawn, execSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const relayDir = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not become ready within ' + timeoutMs + 'ms');
}

// opts.vars: {NAME: value} overrides for [vars] (e.g. a tiny ROOM_TTL_HOURS).
async function startRelay(opts) {
  const vars = (opts && opts.vars) || {};
  const port = await freePort();
  const inspectorPort = await freePort();
  const args = ['--yes', 'wrangler@4', 'dev', '--local', '--port', String(port),
    '--inspector-port', String(inspectorPort), '--log-level', 'warn', '--show-interactive-dev-session', 'false'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const child = spawn(['npx', ...args].join(' '), {
    cwd: relayDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',  // own process group, so stop() reaches workerd too
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  try {
    await Promise.race([
      waitForHealth(port, 180000),
      exited.then(code => { throw new Error('wrangler dev exited early (' + code + '):\n' + output); }),
    ]);
  } catch (e) {
    stop();
    throw e;
  }
  function stop() {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') {
      try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { child.kill('SIGTERM'); }
    }
  }
  return { port, url: `ws://127.0.0.1:${port}`, stop, output: () => output };
}

module.exports = { startRelay, freePort };
