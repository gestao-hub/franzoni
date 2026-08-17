import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { applyPendingMigrations } from './bootstrap.mjs';
import { loadConfig } from './config.mjs';
import { waitForCompleteHubStatus } from './health.mjs';
import { checkAndUpdate } from './updater.mjs';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function apiFor(platform) {
  return platform === 'win32' ? path.win32 : path;
}

export function resolveForceUpdatePaths({
  configArg = 'config.json',
  root,
  platform = process.platform,
  rawPaths = {},
} = {}) {
  const api = apiFor(platform);
  const installRoot = api.normalize(root || (platform === 'win32' ? 'C:\\Exped' : MODULE_ROOT));
  const resolve = (value) => api.isAbsolute(value) ? api.normalize(value) : api.resolve(installRoot, value);
  return {
    root: installRoot,
    configPath: resolve(configArg || 'config.json'),
    releasesDir: resolve(rawPaths.releasesDir || 'releases'),
    ptrPath: resolve(rawPaths.releasesPtr || api.join('releases', 'current')),
  };
}

function setIf(name, value) {
  if (value !== undefined && value !== null && value !== '') process.env[name] = String(value);
}

export async function runForceUpdate({
  configArg = process.argv[2] || 'config.json',
  root = process.env.EXPED_ROOT,
  platform = process.platform,
  logger = console,
} = {}) {
  const initial = resolveForceUpdatePaths({ configArg, root, platform });
  const raw = JSON.parse(readFileSync(initial.configPath, 'utf8'));
  const resolved = resolveForceUpdatePaths({
    configArg,
    root: initial.root,
    platform,
    rawPaths: raw.paths || {},
  });
  const api = apiFor(platform);
  const pgBin = api.join(resolved.root, 'bin', 'pgsql', 'bin');
  process.env.PATH = `${pgBin}${path.delimiter}${api.join(resolved.root, 'bin', 'node')}${path.delimiter}${process.env.PATH || ''}`;
  setIf('EXPED_PG_BIN', pgBin);
  setIf('EXPED_CERT_DIR', api.join(resolved.root, 'cert'));
  const portEnv = {
    pg: 'EXPED_PG_PORT',
    postgrest: 'EXPED_POSTGREST_PORT',
    gotrue: 'EXPED_GOTRUE_PORT',
    gateway: 'EXPED_GATEWAY_PORT',
    storage: 'EXPED_STORAGE_PORT',
    app: 'EXPED_APP_PORT',
    frontdoor: 'EXPED_FRONTDOOR_PORT',
    events: 'EXPED_EVENTS_PORT',
  };
  for (const [key, envName] of Object.entries(portEnv)) setIf(envName, raw.ports?.[key]);
  setIf('EXPED_PG_DATA', raw.paths?.pgData || api.join(resolved.root, 'data', 'pg'));
  setIf('EXPED_PG_HOST', raw.paths?.pgHost || '127.0.0.1');
  setIf('EXPED_DB', raw.paths?.db);
  setIf('EXPED_DB_USER', raw.paths?.user);
  setIf('EXPED_JWT_SECRET', raw.jwtSecret);
  setIf('EXPED_MANIFEST_URL', raw.manifestUrl);
  setIf('EXPED_VERSION', raw.version);
  setIf('EXPED_CLOUD_API', raw.cloud?.apiBase);
  setIf('EXPED_DEVICE_TOKEN', raw.cloud?.deviceToken);
  setIf('EXPED_SYNC_INTERVAL_MS', raw.cloud?.syncIntervalMs);
  setIf('EXPED_AGENT_SYNC_PORT', raw.agent?.syncNowPort);
  setIf('EXPED_AGENT_HEALTH_PATH', raw.agent?.healthPath);
  setIf('EXPED_AGENT_STARTUP_MODE', raw.agent?.startupMode);

  const cfg = loadConfig({
    paths: {
      ...(raw.paths || {}),
      root: resolved.root,
      releasesDir: resolved.releasesDir,
      releasesPtr: resolved.ptrPath,
    },
    agent: raw.agent || {},
  });
  if (!cfg.manifestUrl) throw new Error('config.json sem manifestUrl - nada a forcar');

  const nssm = api.join(resolved.root, 'bin', 'nssm.exe');
  const service = process.env.EXPED_SERVICE_NAME || 'ExpedHub';
  const statusPort = cfg.ports.status || cfg.ports.app + 1;
  return checkAndUpdate(cfg, {
    getCurrentVersion: () => '0.0.0',
    restart: async () => execFileSync(nssm, ['restart', service], { stdio: 'inherit' }),
    health: async () => waitForCompleteHubStatus(
      `http://127.0.0.1:${statusPort}/status`,
      90_000,
    ),
    migrate: async (releaseDir) => applyPendingMigrations(
      cfg,
      cfg.paths.db,
      api.join(releaseDir, 'supabase', 'migrations'),
    ),
    logger,
  });
}

const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();

if (isMain) {
  runForceUpdate()
    .then((result) => {
      console.log('RESULTADO:', JSON.stringify(result));
      process.exit(result.updated ? 0 : 1);
    })
    .catch((error) => {
      console.error('[force-update] FALHA:', error?.stack || error);
      process.exit(1);
    });
}
