// Maestro do Hub Exped — orquestrador único da pilha local (Windows/offline).
//
// Sobe e supervisiona, NA ORDEM, todas as peças do "Jeito A" (Supabase nativo,
// sem Docker) + o app Next standalone, expõe um /status interno e roda o
// auto-update periódico (updater.mjs) com rollback. SIGTERM derruba tudo na
// ordem inversa.
//
// Ordem de subida:
//   1. Postgres (pg_ctl)            -> waitForTcp(:pg)
//   2. bootstrap(cfg)               (idempotente: cria DB/auth/schema)
//   3. PostgREST / GoTrue serve / storage-local / gateway -> waitForHttp/Tcp
//   4. App Next standalone (.next/standalone/server.js) -> waitForHttp(/login)
//   5. timer checkAndUpdate (só se cfg.manifestUrl)
//   6. httpserver /status (porta cfg.ports.status || app+1)
//
// ----------------------------------------------------------------------------
// SMOKE TEST (2026-05-31, Linux, reaproveitando o Postgres do spike na :54329):
//   cfg alternativo: app 3010, gateway 54340, storage 5412, postgrest 54341,
//   gotrue 9991, status 3011, DB exped_maestro_smoke (separado do spike 'exped').
//   PROVADO: Postgres (reuso) + bootstrap (criou exped_maestro_smoke do zero:
//   empresas/auth.users), PostgREST :54341, GoTrue serve :9991, storage :5412,
//   gateway :54340 subiram e o /status :3011 reportou todas as peças running:true.
//   App Next standalone: ver nota no fim deste arquivo / hub/README.md.
//   Stack do spike NÃO foi derrubado; DB de smoke e processos foram limpos no fim.
// ----------------------------------------------------------------------------

import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

import { Supervisor } from './supervisor.mjs';
import { readAgentReadiness, waitForHttp, waitForTcp, tcpAlive } from './health.mjs';
import { startStorage } from './storage-local.mjs';
import { loadConfig } from './config.mjs';
import { bootstrap, applyPendingMigrations } from './bootstrap.mjs';
import { checkAndUpdate } from './updater.mjs';
import { makeKeys } from './keys.mjs';
import { exe } from './platform.mjs';
import * as sync from './sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LS = path.join(ROOT, 'scripts', 'local-stack');
const PG_BIN = process.env.EXPED_PG_BIN || '/usr/lib/postgresql/16/bin';

const noopLogger = { info: () => {}, error: () => {} };

/** logger simples: console + (se logPath) arquivo append. */
function makeLogger(logPath) {
  let stream = null;
  if (logPath) {
    try {
      stream = createWriteStream(logPath, { flags: 'a' });
    } catch {
      stream = null;
    }
  }
  const write = (lvl, msg) => {
    const line = `[${new Date().toISOString()}] [${lvl}] ${msg}`;
    if (lvl === 'error') console.error(line);
    else console.log(line);
    stream?.write(line + '\n');
  };
  return {
    info: (m) => write('info', m),
    error: (m) => write('error', m),
    close: () => stream?.end(),
  };
}

/** host TCP do Postgres (em Linux o pgHost é socket dir; o app/peers usam 127.0.0.1). */
function pgTcpHost(cfg) {
  return cfg.paths.pgHost.startsWith('/') ? '127.0.0.1' : cfg.paths.pgHost;
}

/**
 * Um diretório de dados é um cluster Postgres válido sse tem o arquivo
 * PG_VERSION (criado pelo initdb). Se NÃO existe, precisamos rodar initdb antes
 * do pg_ctl start. Idempotente: já inicializado => false (pula o initdb).
 */
export function needsInitdb(pgDataDir) {
  if (!pgDataDir) return true;
  return !existsSync(path.join(pgDataDir, 'PG_VERSION'));
}

/**
 * Resolve o entrypoint do app testando, em ordem:
 *   1. <releasesDir>/<pointer>/server.js  (release adotada pelo auto-update)
 *   2. <root>/app/server.js               (base instalada)
 *   3. <root>/.next/standalone/server.js  (dev)
 */
export function resolveAppEntrypoint(root, releasesDir, pointer, exists = existsSync) {
  if (pointer && releasesDir) {
    const rel = path.join(releasesDir, pointer, 'server.js');
    if (exists(rel)) return rel;
  }
  const installer = path.join(root, 'app', 'server.js');
  const dev = path.join(root, '.next', 'standalone', 'server.js');
  if (exists(installer)) return installer;
  return dev;
}

/** Lê o ponteiro `current` (versão adotada). Ausente/vazio → null. Síncrono. */
export function readPointerSync(ptrPath, read = readFileSync) {
  try {
    return String(read(ptrPath, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

/** Versão atual do app: ponteiro adotado > cfg.version baked no install > 0.0.0. */
export function currentAppVersion(pointer, cfgVersion) {
  return pointer || cfgVersion || '0.0.0';
}

export async function stopSupervisorAndWait(supervisor, timeoutMs = 5000) {
  if (!supervisor) return true;
  const child = supervisor.child;
  supervisor.stop();
  if (!child || child.exitCode !== null) return true;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

export async function stopSupervisorsSequentially(
  supervisors,
  stopOne = stopSupervisorAndWait,
) {
  const stopped = [];
  for (const name of ['frontdoor', 'events', 'app', 'gateway', 'gotrue', 'postgrest']) {
    if (!supervisors[name]) continue;
    await stopOne(supervisors[name]);
    stopped.push(name);
  }
  return stopped;
}

function closeServerAndWait(server, timeoutMs = 5000) {
  if (!server) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    try { server.close(() => finish(true)); }
    catch { finish(false); }
  });
}

// --------------------------------------------------------------------------
// Construtores das peças (Supervisors). Funções pequenas, uma por serviço.
// --------------------------------------------------------------------------

function pgSupervisor(cfg, logDir) {
  // pg_ctl start é one-shot (sai após disparar o daemon); não supervisionamos
  // restart aqui — o postmaster é gerido pelo próprio pg_ctl. Mantemos um
  // Supervisor só pra registro/status, com maxRestarts=0.
  return new Supervisor({
    name: 'postgres',
    cmd: exe(path.join(PG_BIN, 'pg_ctl')),
    // -D usa o DIRETORIO DE DADOS (pgData), nunca o host de conexao.
    // -o repassa opcoes ao postmaster: porta sempre; -k (socket dir) só quando
    // pgData parece um socket dir Unix (Linux). No Windows não há socket Unix.
    args: [
      '-D', cfg.paths.pgData,
      '-o', cfg.paths.pgData.startsWith('/')
        ? `-p ${cfg.ports.pg} -k ${cfg.paths.pgData} -h 127.0.0.1`
        : `-p ${cfg.ports.pg} -h 127.0.0.1`,
      '-l', path.join(logDir, 'postgres.log'),
      'start',
    ],
    maxRestarts: 0,
    logPath: path.join(logDir, 'pg_ctl.log'),
  });
}

function postgrestSupervisor(cfg, logDir) {
  return new Supervisor({
    name: 'postgrest',
    cmd: exe(path.join(LS, 'bin', 'postgrest')),
    args: [path.join(LS, 'postgrest.conf')],
    cwd: ROOT,
    env: {
      // Bind LOOPBACK explícito: o default do PostgREST é "!4" (todas as interfaces IPv4 =
      // 0.0.0.0), o que o exporia na LAN pulando o porteiro/TLS. Só o frontdoor fica em 0.0.0.0.
      PGRST_SERVER_HOST: '127.0.0.1',
      PGRST_SERVER_PORT: String(cfg.ports.postgrest),
      PGRST_DB_URI: `postgres://authenticator:authpass@${pgTcpHost(cfg)}:${cfg.ports.pg}/${cfg.paths.db}`,
      PGRST_JWT_SECRET: cfg.jwtSecret,
    },
    logPath: path.join(logDir, 'postgrest.log'),
    backoffMs: 1000,
  });
}

function gotrueSupervisor(cfg, logDir) {
  const host = pgTcpHost(cfg);
  return new Supervisor({
    name: 'gotrue',
    cmd: exe(path.join(LS, 'bin', 'auth')),
    args: ['serve'],
    cwd: ROOT,
    env: {
      GOTRUE_DB_DRIVER: 'postgres',
      DATABASE_URL: `postgres://supabase_auth_admin:authpass@${host}:${cfg.ports.pg}/${cfg.paths.db}?search_path=auth&sslmode=disable`,
      GOTRUE_API_HOST: '127.0.0.1',
      GOTRUE_API_PORT: String(cfg.ports.gotrue),
      API_EXTERNAL_URL: `http://127.0.0.1:${cfg.ports.gotrue}`,
      GOTRUE_JWT_SECRET: cfg.jwtSecret,
      GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
      GOTRUE_JWT_ADMIN_ROLES: 'service_role',
      GOTRUE_JWT_AUD: 'authenticated',
      GOTRUE_SITE_URL: `http://127.0.0.1:${cfg.ports.app}`,
      // NÃO setamos GOTRUE_URI_ALLOW_LIST: o hub usa login por SENHA (sem magic link/OAuth/
      // recovery → sem redirect_to), então a allow-list não é usada. Um '*' seria open-redirect
      // à toa. Se algum fluxo com redirect surgir, restringir à origem exata do porteiro.
      GOTRUE_DISABLE_SIGNUP: 'false',
      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
      GOTRUE_MAILER_AUTOCONFIRM: 'true',
      GOTRUE_DB_MIGRATIONS_PATH: path.join(LS, 'bin', 'migrations'),
    },
    logPath: path.join(logDir, 'gotrue.log'),
    backoffMs: 1000,
  });
}

function gatewaySupervisor(cfg, logDir) {
  return new Supervisor({
    name: 'gateway',
    cmd: process.execPath,
    args: [path.join(LS, 'gateway.mjs')],
    cwd: ROOT,
    env: {
      GATEWAY_PORT: String(cfg.ports.gateway),
      STORAGE_PORT: String(cfg.ports.storage),
    },
    logPath: path.join(logDir, 'gateway.log'),
    backoffMs: 1000,
  });
}

function eventsSupervisor(cfg, logDir) {
  return new Supervisor({
    name: 'events',
    cmd: process.execPath,
    args: [path.join(ROOT, 'hub', 'events.mjs')],
    cwd: ROOT,
    env: {
      EVENTS_PORT: String(cfg.ports.events),
      EXPED_PG_PORT: String(cfg.ports.pg),
      EXPED_PG_HOST: pgTcpHost(cfg),
      EXPED_PG_USER: cfg.paths.user || 'postgres',
      EXPED_PG_DB: cfg.paths.db,
    },
    logPath: path.join(logDir, 'events.log'),
    backoffMs: 1500,
  });
}

function frontdoorSupervisor(cfg, logDir) {
  return new Supervisor({
    name: 'frontdoor',
    cmd: process.execPath,
    args: [path.join(ROOT, 'hub', 'frontdoor.mjs')],
    cwd: ROOT,
    env: {
      FRONTDOOR_PORT: String(cfg.ports.frontdoor),
      FRONTDOOR_FALLBACK_PORT: String(cfg.ports.frontdoorFallback || 8443),
      APP_PORT: String(cfg.ports.app),
      GATEWAY_PORT: String(cfg.ports.gateway),
      EVENTS_PORT: String(cfg.ports.events),
      CERT_DIR: cfg.paths.certDir || '',
    },
    logPath: path.join(logDir, 'frontdoor.log'),
    backoffMs: 1500,
  });
}

function appSupervisor(cfg, logDir, keys) {
  const gatewayUrl = `http://127.0.0.1:${cfg.ports.gateway}`;
  const releasesDir = cfg.paths.releasesDir || path.join(ROOT, 'releases');
  const ptrPath = cfg.paths.releasesPtr || path.join(releasesDir, 'current');
  return new Supervisor({
    name: 'app',
    cmd: process.execPath,
    // Entrypoint: a release apontada por `current` (auto-update) > app/server.js > dev.
    // Lido a cada start, então o restart pós-update já sobe a versão nova.
    args: [resolveAppEntrypoint(ROOT, releasesDir, readPointerSync(ptrPath))],
    cwd: ROOT,
    env: {
      PORT: String(cfg.ports.app),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      // Marca explícita de que o app roda no hub (gestão de identidade fica read-only;
      // a detecção por URL localhost já cobre, isto é robustez/override).
      EXPED_HUB: '1',
      // SUPABASE_* (não-públicas) são lidas pelo server em runtime (não assadas no build);
      // NEXT_PUBLIC_* ficam como fallback do cliente do browser. Mesmos valores de propósito.
      SUPABASE_URL: gatewayUrl,
      SUPABASE_ANON_KEY: keys.anon,
      SUPABASE_SERVICE_ROLE_KEY: keys.service,
      NEXT_PUBLIC_SUPABASE_URL: gatewayUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: keys.anon,
    },
    logPath: path.join(logDir, 'app.log'),
    backoffMs: 1500,
  });
}

// --------------------------------------------------------------------------
// /status — servidor HTTP interno reportando o estado de cada peça.
// --------------------------------------------------------------------------

function startStatusServer(port, getState) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if ((req.url || '').startsWith('/status')) {
        // getState pode ser async (faz probe TCP do Postgres) — aguardamos.
        const state = await getState();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(state, null, 2));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'use /status' }));
      }
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** snapshot de um Supervisor pro /status. */
function peerState(sup) {
  return {
    name: sup.name,
    running: !!sup.child && sup.child.exitCode === null && !sup.child.killed,
    restarts: sup.restarts,
    stopped: sup.stopped,
  };
}

export async function buildAgentStatus(agentCfg, readReadiness = readAgentReadiness) {
  const readiness = await readReadiness(agentCfg.healthPath, {
    maxAgeMs: agentCfg.healthMaxAgeMs,
  });
  return {
    ...readiness,
    startupMode: agentCfg.startupMode,
    survivesRebootWithoutLogon: false,
    syncNowPort: agentCfg.syncNowPort,
    recovery: {
      mechanism: 'interactive_logon',
      guaranteedBeforeLogon: false,
      diagnostic:
        'O Agent recupera somente apos logon da conta operacional; pre-login nao e garantido.',
    },
  };
}

// --------------------------------------------------------------------------
// startMaestro — sobe tudo, retorna { stop, status, port }.
// --------------------------------------------------------------------------

export async function startMaestro(cfg, opts = {}) {
  const logDir = cfg.paths.logDir || path.join(ROOT, '.hub-logs');
  await mkdir(logDir, { recursive: true });
  const logger = opts.logger || makeLogger(path.join(logDir, 'maestro.log'));

  const startApp = opts.startApp !== false; // permite pular o app no smoke
  const supervisors = {};
  let statusServer = null;
  let storageHandle = null;
  let updateTimer = null;
  let stopSync = null;
  let stopped = false;

  // 1. Postgres -------------------------------------------------------------
  // reusePg=true: assume um Postgres já de pé (não dá start nem stop nele).
  const reusePg = opts.reusePg === true;
  if (!reusePg) {
    // initdb auto-suficiente: se o data dir ainda não é um cluster válido
    // (sem PG_VERSION), inicializa ANTES do pg_ctl start. Cobre instalador
    // Windows (data dir vazio no 1º boot), smoke e Linux. Idempotente.
    if (needsInitdb(cfg.paths.pgData)) {
      logger.info(`initdb: inicializando cluster em ${cfg.paths.pgData}`);
      execFileSync(
        exe(path.join(PG_BIN, 'initdb')),
        ['-D', cfg.paths.pgData, '-U', cfg.paths.user || 'postgres', '-E', 'UTF8'],
        { stdio: 'ignore' },
      );
      logger.info('initdb concluido');
    }
    logger.info(`subindo Postgres :${cfg.ports.pg}`);
    supervisors.postgres = pgSupervisor(cfg, logDir).start();
  } else {
    logger.info(`reusando Postgres existente :${cfg.ports.pg}`);
  }
  await waitForTcp(pgTcpHost(cfg), cfg.ports.pg, 30000);

  // 2. bootstrap ------------------------------------------------------------
  logger.info(`bootstrap do banco "${cfg.paths.db}"`);
  const boot = await bootstrap(cfg);
  logger.info(`bootstrap ok (fresh=${boot.fresh})`);

  // 3. PostgREST / GoTrue / storage / gateway -------------------------------
  logger.info(`subindo PostgREST :${cfg.ports.postgrest}`);
  supervisors.postgrest = postgrestSupervisor(cfg, logDir).start();
  await waitForTcp('127.0.0.1', cfg.ports.postgrest, 30000);

  logger.info(`subindo GoTrue :${cfg.ports.gotrue}`);
  supervisors.gotrue = gotrueSupervisor(cfg, logDir).start();
  await waitForHttp(`http://127.0.0.1:${cfg.ports.gotrue}/health`, 30000);

  logger.info(`subindo storage-local :${cfg.ports.storage}`);
  storageHandle = await startStorage({
    port: cfg.ports.storage,
    root: cfg.paths.storageRoot || path.join(logDir, 'storage'),
    secret: cfg.jwtSecret,
  });

  logger.info(`subindo gateway :${cfg.ports.gateway}`);
  supervisors.gateway = gatewaySupervisor(cfg, logDir).start();
  await waitForHttp(`http://127.0.0.1:${cfg.ports.gateway}/auth/v1/health`, 30000);

  // 4. App Next standalone --------------------------------------------------
  let keys = { anon: '', service: '' };
  if (startApp) {
    keys = makeKeys(cfg.jwtSecret);
    logger.info(`subindo app :${cfg.ports.app}`);
    supervisors.app = appSupervisor(cfg, logDir, keys).start();
    await waitForHttp(`http://127.0.0.1:${cfg.ports.app}/login`, 60000);
    logger.info('app respondeu em /login');

    // Tempo-real (SSE + poll do banco) — antes do porteiro, que roteia /avisos pra cá.
    logger.info(`subindo events :${cfg.ports.events}`);
    supervisors.events = eventsSupervisor(cfg, logDir).start();

    // Porteiro de rede (LAN): única peça que escuta em 0.0.0.0. Depois do app+events
    // (proxia app+gateway+/avisos). HTTPS auto se há cert no certDir.
    logger.info(`subindo frontdoor :${cfg.ports.frontdoor}`);
    supervisors.frontdoor = frontdoorSupervisor(cfg, logDir).start();
  }

  // 4.5 Cliente de sync (sub-projeto 3) -------------------------------------
  // Liga só se apiBase E deviceToken presentes; ausentes => modo ilha (sem sync).
  const cloud = cfg.cloud || {};
  if (cloud.apiBase && cloud.deviceToken) {
    const syncDb = opts.syncDb || sync.makePsqlDb(cfg);
    stopSync = sync.start({
      db: syncDb,
      apiBase: cloud.apiBase,
      deviceToken: cloud.deviceToken,
      intervalMs: cloud.syncIntervalMs || 10000,
      log: logger,
    });
    logger.info(`sync ligado contra ${cloud.apiBase} (cada ${cloud.syncIntervalMs || 10000}ms)`);
  } else {
    logger.info('sync desligado (modo ilha: sem cloud.apiBase/deviceToken)');
  }

  // 6. /status --------------------------------------------------------------
  const statusPort = cfg.ports.status || cfg.ports.app + 1;
  const startedAt = new Date().toISOString();
  const status = async () => {
    const s = sync.getState();
    const peers = Object.values(supervisors).map(peerState);
    // O Postgres sobe via `pg_ctl start`, um lançador one-shot que SAI logo após
    // disparar o postmaster. Por isso o child do Supervisor não representa o
    // banco e peerState reportaria running:false mesmo com o banco saudável.
    // Conferimos a porta TCP de verdade — é o que diz a verdade sobre o daemon.
    const pg = peers.find((p) => p.name === 'postgres');
    if (pg) pg.running = await tcpAlive(pgTcpHost(cfg), cfg.ports.pg, 1000);
    const agent = await buildAgentStatus(cfg.agent);
    return {
      maestro: { startedAt, manifestUrl: cfg.manifestUrl || null },
      storage: { name: 'storage', running: !!storageHandle, port: cfg.ports.storage },
      peers,
      agent,
      sync: {
        enabled: !!stopSync,
        lastSyncOk: s.lastSyncOk,
        pendingPush: s.pendingPush,
        lastError: s.lastError,
        lastSyncAt: s.lastSyncAt,
      },
    };
  };
  statusServer = await startStatusServer(statusPort, status);
  logger.info(`/status em http://127.0.0.1:${statusPort}/status`);

  // 5. auto-update periódico ------------------------------------------------
  if (cfg.manifestUrl) {
    const intervalMs = cfg.updateIntervalMs || 3600_000;
    const restart = async () => {
      supervisors.app?.stop();
      supervisors.app = appSupervisor(cfg, logDir, keys).start();
    };
    const health = async () => {
      await waitForHttp(`http://127.0.0.1:${cfg.ports.app}/login`, 60000);
    };
    const releasesDir = cfg.paths.releasesDir || path.join(ROOT, 'releases');
    const ptrPath = cfg.paths.releasesPtr || path.join(releasesDir, 'current');
    updateTimer = setInterval(() => {
      checkAndUpdate(cfg, {
        getCurrentVersion: () => currentAppVersion(readPointerSync(ptrPath), cfg.version),
        restart,
        health,
        logger,
        migrate: async (releaseDir) =>
          applyPendingMigrations(cfg, cfg.paths.db, path.join(releaseDir, 'supabase', 'migrations')),
      }).catch((e) => logger.error(`updater: ${e?.message}`));
    }, intervalMs);
    updateTimer.unref?.();
    logger.info(`auto-update a cada ${intervalMs}ms (manifest ${cfg.manifestUrl})`);
  }

  // stop — ordem inversa ----------------------------------------------------
  async function stop() {
    if (stopped) return;
    stopped = true;
    logger.info('parando maestro (ordem inversa)');
    if (updateTimer) clearInterval(updateTimer);
    if (stopSync) stopSync();
    await closeServerAndWait(statusServer);
    await stopSupervisorsSequentially({
      frontdoor: supervisors.frontdoor,
      events: supervisors.events,
      app: supervisors.app,
      gateway: supervisors.gateway,
    });
    await closeServerAndWait(storageHandle);
    await stopSupervisorsSequentially({
      gotrue: supervisors.gotrue,
      postgrest: supervisors.postgrest,
    });
    supervisors.postgres?.stop();
    // Postgres: pg_ctl stop (não matamos o postmaster com kill do Supervisor).
    // Em reusePg NÃO paramos — o cluster não é nosso.
    if (!reusePg) {
      try {
        execFileSync(exe(path.join(PG_BIN, 'pg_ctl')), ['-D', cfg.paths.pgData, 'stop', '-m', 'fast'], {
          stdio: 'ignore',
          timeout: 20_000,
        });
      } catch {
        /* já parado */
      }
    }
    logger.info?.('maestro parado');
    logger.close?.();
  }

  return { stop, status, statusPort, supervisors };
}

// --------------------------------------------------------------------------
// Standalone: node hub/maestro.mjs
// --------------------------------------------------------------------------
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  const cfg = loadConfig();
  startMaestro(cfg).then((m) => {
    const shutdown = () => m.stop().then(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }).catch((err) => {
    console.error('[maestro] falha ao subir:', err);
    process.exit(1);
  });
}

export default startMaestro;
