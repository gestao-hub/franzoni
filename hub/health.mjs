import net from 'node:net';
import { readFile } from 'node:fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ESSENTIAL_PEERS = Object.freeze([
  'postgres',
  'postgrest',
  'gotrue',
  'gateway',
  'app',
  'events',
  'frontdoor',
]);

function safeString(value, max = 500) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

export function projectAgentReadiness(snapshot, {
  now = Date.now(),
  maxAgeMs = 90_000,
} = {}) {
  const checkedAt = Date.parse(snapshot?.checkedAt || '');
  const ageMs = Number.isFinite(checkedAt) ? Math.max(0, now - checkedAt) : null;
  const running =
    Number.isInteger(snapshot?.pid) && snapshot.pid > 0 &&
    ageMs !== null && ageMs <= maxAgeMs;
  const hiper = snapshot?.hiper && typeof snapshot.hiper === 'object' ? snapshot.hiper : {};

  return {
    running,
    pid: running ? snapshot.pid : null,
    agentVersion: safeString(snapshot?.agentVersion, 64),
    checkedAt: Number.isFinite(checkedAt) ? new Date(checkedAt).toISOString() : null,
    ageMs,
    diagnostic: running
      ? 'Agent em execucao; o estado da consulta Hiper e reportado separadamente.'
      : 'Agent sem heartbeat recente; requer logon da conta operacional.',
    hiper: {
      connected: hiper.connected === true,
      queryOk: hiper.queryOk === true,
      schemaCompatible: hiper.schemaCompatible === true,
      targetSchema: safeString(hiper.targetSchema, 80),
      database: safeString(hiper.database, 128),
      serverVersion: safeString(hiper.serverVersion, 128),
      sampleOrderId: Number.isInteger(hiper.sampleOrderId) ? hiper.sampleOrderId : null,
      missingColumns: Array.isArray(hiper.missingColumns)
        ? hiper.missingColumns.filter((v) => typeof v === 'string').slice(0, 100)
        : [],
      error: safeString(hiper.error),
    },
  };
}

export async function readAgentReadiness(healthPath, options = {}) {
  try {
    const raw = await (options.readFileImpl || readFile)(healthPath, 'utf8');
    return projectAgentReadiness(JSON.parse(raw), options);
  } catch (error) {
    return {
      ...projectAgentReadiness(null, options),
      diagnostic: `readiness do Agent indisponivel: ${error?.message || String(error)}`,
    };
  }
}

export function assertCompleteHubStatus(status, { essentialPeers = ESSENTIAL_PEERS } = {}) {
  if (!status || typeof status !== 'object') throw new Error('/status ausente ou invalido');
  if (status.storage?.running !== true) throw new Error('/status: storage nao esta running');

  const peers = new Map(
    (Array.isArray(status.peers) ? status.peers : []).map((peer) => [peer?.name, peer]),
  );
  for (const name of essentialPeers) {
    if (peers.get(name)?.running !== true) {
      throw new Error(`/status: peer essencial ${name} nao esta running`);
    }
  }

  if (status.agent?.startupMode !== 'interactive_logon') {
    throw new Error('/status: Agent nao esta no modo interactive_logon suportado');
  }
  if (status.agent?.survivesRebootWithoutLogon !== false) {
    throw new Error('/status: Agent afirmou recuperacao sem login sem garantia real');
  }
  if (status.agent?.running !== true) throw new Error('/status: processo do Agent sem readiness');
  if (status.agent?.hiper?.connected !== true) throw new Error('/status: Agent nao conectou ao Hiper');
  if (status.agent?.hiper?.queryOk !== true) throw new Error('/status: consulta read-only ao Hiper falhou');
  if (status.agent?.hiper?.schemaCompatible !== true) {
    throw new Error('/status: schema do Hiper nao foi comprovado compativel');
  }
  if (status.agent?.hiper?.targetSchema !== 'Hiper Loja 197') {
    throw new Error('/status: probe nao comprovou o schema alvo Hiper Loja 197');
  }

  if (status.sync?.enabled !== true) throw new Error('/status: sync cloud nao esta enabled');
  if (status.sync?.lastError !== null) {
    throw new Error(`/status: sync cloud com lastError: ${status.sync?.lastError || 'desconhecido'}`);
  }
  return true;
}

export async function waitForCompleteHubStatus(url, timeoutMs = 90_000, options = {}) {
  const deadline = Date.now() + timeoutMs;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const status = await res.json();
      assertCompleteHubStatus(status, options);
      return status;
    } catch (error) {
      lastError = error;
    }
    await sleep(options.pollMs || 1000);
  }
  throw new Error(`health completo timeout: ${url}: ${lastError?.message || 'sem resposta'}`);
}

/**
 * Espera um endpoint HTTP ficar pronto. Resolve true assim que responder com
 * status < 500. Rejeita se o deadline passar sem nenhuma resposta utilizável.
 */
export async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch {
      /* ainda subindo */
    }
    await sleep(500);
  }
  throw new Error(`health timeout: ${url}`);
}

/**
 * Probe ÚNICO (não fica retentando, ao contrário de waitForTcp): há algo
 * aceitando conexão TCP em host:port agora? Resolve true se conectou, false se
 * recusou/timeout/erro. Usado pelo /status pra refletir o estado REAL de uma
 * peça cujo processo supervisionado não representa o daemon (ex.: Postgres, que
 * sobe via `pg_ctl start` — um lançador one-shot que sai após disparar o
 * postmaster). Checar a porta diz a verdade; checar o child do pg_ctl, não.
 */
export function tcpAlive(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    const s = net.connect({ host, port }, () => finish(true));
    s.on('error', () => finish(false));
    s.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * Espera uma porta TCP aceitar conexão. Resolve true na primeira conexão
 * bem-sucedida. Rejeita se o deadline passar sem conseguir conectar.
 */
export async function waitForTcp(host, port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host, port }, () => {
        s.end();
        resolve(true);
      });
      s.on('error', () => resolve(false));
      s.setTimeout(1500, () => {
        s.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await sleep(500);
  }
  throw new Error(`tcp timeout: ${host}:${port}`);
}
