import { spawn } from 'node:child_process';
import { runMigrations } from '../packages/db/src/migrate.js';
import { startControlCenter } from '../apps/control-center/src/index.js';
import { startCloudflaredSafely } from '../packages/common/src/tunnel-command.js';
import { getAdminToken } from '../packages/common/src/secrets.js';

if (!process.env.YOUPI_MODE) process.env.YOUPI_MODE = 'localhost';
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';

console.log('====================================================');
console.log('🚀 Starting YOUPI PG (Development / Localhost Mode)');
console.log('====================================================');

// 1. Run database migrations & seeds
console.log('[1/2] Checking and applying database migrations...');
const migrationResult = runMigrations();
// Make the documented dashboard unlock token available before the first request.
// Never print its value; the operator reads it from the private local file.
getAdminToken();
console.log(`[✓] Database ready. Default merchant: ${migrationResult.defaultMerchant.businessName}`);

// Check for user-configured Cloudflare Tunnel command
let tunnelProcess = null;
const branding = migrationResult.defaultMerchant?.branding || {};
const tunnelCmd = process.env.CLOUDFLARE_TUNNEL_COMMAND || branding.cloudflareTunnelCommand;

if (tunnelCmd && tunnelCmd.trim()) {
  console.log(`\n[☁️ Cloudflare Tunnel] Executing tunnel command before starting services:`);
  tunnelProcess = startCloudflaredSafely(tunnelCmd, { stdio: 'inherit' });
  if (tunnelProcess) console.log(`[✓] Cloudflare Tunnel process launched (PID: ${tunnelProcess.pid}).\n`);
  // Brief pause to establish socket before services spin up
  await new Promise(r => setTimeout(r, 1500));
}

// 2. Start Control Center supervisor and launch all services
console.log('[2/2] Launching Local Process Control Center on port 8090...');
const cc = await startControlCenter(8090);

console.log('\n[✓] Control Center is online at: http://localhost:8090');
console.log('[*] Starting all modular gateway services...\n');

await cc.processManager.startAll();

console.log('====================================================');
console.log('🟢 ALL SERVICES ONLINE & OPERATIONAL');
console.log('====================================================');
for (const service of cc.processManager.services) {
  console.log(`- ${service.name}: http://localhost:${service.port}`);
}
console.log('Dashboard unlock token: data/.secrets/admin_api_token (or ADMIN_API_TOKEN if configured).');
if (process.env.AMAZON_PAY_DASHBOARD_MANAGED === 'true') {
  console.log('Open the admin dashboard to connect Amazon Pay and WhatsApp.');
}
console.log('====================================================');
console.log('Press Ctrl+C to stop all services gracefully.');

// Handle graceful shutdown
const shutdown = async () => {
  console.log('\nStopping all services gracefully...');
  if (tunnelProcess && tunnelProcess.pid) {
    try {
      console.log('Terminating Cloudflare Tunnel process...');
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(tunnelProcess.pid), '/f', '/t']);
      } else {
        tunnelProcess.kill('SIGTERM');
      }
    } catch {}
  }
  await cc.close();
  console.log('All processes terminated cleanly.');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

