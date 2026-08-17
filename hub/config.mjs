/**
 * Configuração do hub local do Exped. Um objeto de defaults + merge raso com
 * overrides (e algumas envs). Mantido propositalmente simples.
 */

const DEFAULTS = {
  ports: {
    pg: 54329,
    postgrest: 54331,
    gotrue: 9999,
    gateway: 54320,
    storage: 5402,
    app: 3000,
    frontdoor: 443, // porteiro de rede (LAN): única peça em 0.0.0.0
    frontdoorFallback: 8443, // se a 443 estiver ocupada/sem permissão
    events: 54350, // SSE do tempo-real (127.0.0.1)
  },
  paths: {
    // pgData: DIRETORIO DE DADOS do cluster (pg_ctl -D <pgData>).
    // pgHost: HOST DE CONEXAO (psql/PostgREST/GoTrue). Em Linux ambos default
    // para o socket dir do cluster do spike (conexao via socket Unix). Em
    // Windows separam: pgData = C:\Exped\data\pg, pgHost = 127.0.0.1 (TCP).
    pgData: '/tmp/exped-pg',
    pgHost: '/tmp/exped-pg',
    db: 'exped',
    user: 'postgres',
    certDir: '/tmp/exped-cert', // Windows: C:\Exped\cert (server.key/server.crt do mkcert)
    migrationsDir: 'supabase/migrations',
    sqlDir: 'scripts/local-stack',
    authBin: 'scripts/local-stack/bin/auth',
    releasesDir: 'releases',
    releasesPtr: 'releases/current',
  },
  version: '0.0.0', // versão base instalada; o instalador carimba a real (de package.json) no config.json
  manifestUrl: null,
  // Sync com a nuvem (sub-projeto 3). Se apiBase E deviceToken presentes, o
  // maestro liga o cliente de sync; ausentes => modo ilha (hub roda sem sync,
  // não quebra).
  cloud: {
    apiBase: null, // EXPED_CLOUD_API — base da API de sync (ex.: https://app.exped.com.br)
    deviceToken: null, // EXPED_DEVICE_TOKEN — token do dispositivo (Bearer)
    syncIntervalMs: 10000, // EXPED_SYNC_INTERVAL_MS
  },
  agent: {
    syncNowPort: 5005,
    healthPath: 'C:\\ProgramData\\ExpedAgent\\health.json',
    healthMaxAgeMs: 90000,
    startupMode: 'interactive_logon',
    survivesRebootWithoutLogon: false,
  },
};

/** Placeholder histórico (segredo conhecido) — NUNCA aceitar como secret real. */
const JWT_PLACEHOLDER = 'exped-local-super-secret-jwt-with-at-least-32-chars';

/**
 * Resolve e valida o jwtSecret. Ordem: overrides.jwtSecret -> EXPED_JWT_SECRET.
 * Lança se ausente, igual ao placeholder conhecido, ou com menos de 32 chars.
 */
function resolveJwtSecret(overrides) {
  const secret = overrides.jwtSecret ?? process.env.EXPED_JWT_SECRET;
  if (!secret || secret === JWT_PLACEHOLDER || secret.length < 32) {
    throw new Error(
      'EXPED_JWT_SECRET ausente/placeholder: defina um segredo forte (>=32 chars) por instalação',
    );
  }
  return secret;
}

/** merge raso preservando os sub-objetos ports/paths */
function shallowMerge(base, over = {}) {
  const out = { ...base, ...over };
  out.ports = { ...base.ports, ...(over.ports || {}) };
  out.paths = { ...base.paths, ...(over.paths || {}) };
  out.cloud = { ...base.cloud, ...(over.cloud || {}) };
  out.agent = { ...base.agent, ...(over.agent || {}) };
  return out;
}

/**
 * Carrega a config: defaults <- env <- overrides (overrides têm prioridade).
 */
export function loadConfig(overrides = {}) {
  const env = {};
  const ports = {};
  const paths = {};

  if (process.env.EXPED_PG_PORT) ports.pg = Number(process.env.EXPED_PG_PORT);
  if (process.env.EXPED_POSTGREST_PORT) ports.postgrest = Number(process.env.EXPED_POSTGREST_PORT);
  if (process.env.EXPED_GOTRUE_PORT) ports.gotrue = Number(process.env.EXPED_GOTRUE_PORT);
  if (process.env.EXPED_GATEWAY_PORT) ports.gateway = Number(process.env.EXPED_GATEWAY_PORT);
  if (process.env.EXPED_STORAGE_PORT) ports.storage = Number(process.env.EXPED_STORAGE_PORT);
  if (process.env.EXPED_APP_PORT) ports.app = Number(process.env.EXPED_APP_PORT);
  if (process.env.EXPED_FRONTDOOR_PORT) ports.frontdoor = Number(process.env.EXPED_FRONTDOOR_PORT);
  if (process.env.EXPED_EVENTS_PORT) ports.events = Number(process.env.EXPED_EVENTS_PORT);

  // pgData (diretorio de dados) e pgHost (host de conexao) sao independentes.
  // Se EXPED_PG_DATA nao vier, pgData mantem o default — NUNCA herda EXPED_PG_HOST.
  if (process.env.EXPED_PG_DATA) paths.pgData = process.env.EXPED_PG_DATA;
  if (process.env.EXPED_PG_HOST) paths.pgHost = process.env.EXPED_PG_HOST;
  if (process.env.EXPED_DB) paths.db = process.env.EXPED_DB;
  if (process.env.EXPED_DB_USER) paths.user = process.env.EXPED_DB_USER;
  if (process.env.EXPED_CERT_DIR) paths.certDir = process.env.EXPED_CERT_DIR;

  if (process.env.EXPED_MANIFEST_URL) env.manifestUrl = process.env.EXPED_MANIFEST_URL;
  if (process.env.EXPED_VERSION) env.version = process.env.EXPED_VERSION;

  // Sync com a nuvem (sub-projeto 3).
  const cloud = {};
  if (process.env.EXPED_CLOUD_API) cloud.apiBase = process.env.EXPED_CLOUD_API;
  if (process.env.EXPED_DEVICE_TOKEN) cloud.deviceToken = process.env.EXPED_DEVICE_TOKEN;
  if (process.env.EXPED_SYNC_INTERVAL_MS) cloud.syncIntervalMs = Number(process.env.EXPED_SYNC_INTERVAL_MS);

  const agent = {};
  if (process.env.EXPED_AGENT_SYNC_PORT !== undefined) {
    agent.syncNowPort = Number(process.env.EXPED_AGENT_SYNC_PORT);
  }
  if (process.env.EXPED_AGENT_HEALTH_PATH) agent.healthPath = process.env.EXPED_AGENT_HEALTH_PATH;
  if (process.env.EXPED_AGENT_HEALTH_MAX_AGE_MS) {
    agent.healthMaxAgeMs = Number(process.env.EXPED_AGENT_HEALTH_MAX_AGE_MS);
  }
  if (process.env.EXPED_AGENT_STARTUP_MODE) {
    agent.startupMode = process.env.EXPED_AGENT_STARTUP_MODE;
  }
  if (process.env.EXPED_AGENT_SURVIVES_REBOOT_WITHOUT_LOGON !== undefined) {
    agent.survivesRebootWithoutLogon =
      process.env.EXPED_AGENT_SURVIVES_REBOOT_WITHOUT_LOGON === 'true';
  }

  if (Object.keys(ports).length) env.ports = ports;
  if (Object.keys(paths).length) env.paths = paths;
  if (Object.keys(cloud).length) env.cloud = cloud;
  if (Object.keys(agent).length) env.agent = agent;

  // jwtSecret é obrigatório e validado — sem default fixo (segredo por instalação).
  const jwtSecret = resolveJwtSecret(overrides);

  const cfg = shallowMerge(shallowMerge(DEFAULTS, env), overrides);
  if (cfg.agent.startupMode !== 'interactive_logon') {
    throw new Error(
      `agent.startupMode=${JSON.stringify(cfg.agent.startupMode)} recusado: ` +
      'Trusted_Connection exige a identidade interativa comprovada; windows_service nao e suportado',
    );
  }
  if (cfg.agent.survivesRebootWithoutLogon !== false) {
    throw new Error(
      'agent.survivesRebootWithoutLogon deve ser false: nao ha recuperacao garantida sem login',
    );
  }
  if (!Number.isInteger(cfg.agent.syncNowPort) || cfg.agent.syncNowPort < 0 || cfg.agent.syncNowPort > 65535) {
    throw new Error('agent.syncNowPort deve ser um inteiro entre 0 e 65535');
  }
  if (!Number.isInteger(cfg.agent.healthMaxAgeMs) || cfg.agent.healthMaxAgeMs < 1000) {
    throw new Error('agent.healthMaxAgeMs deve ser um inteiro >= 1000');
  }
  cfg.jwtSecret = jwtSecret;
  return cfg;
}

export default loadConfig;
