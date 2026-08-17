import { describe, it, expect } from 'vitest';
import {
  assertCompleteHubStatus,
  projectAgentReadiness,
  waitForHttp,
  tcpAlive,
} from '../health.mjs';
import http from 'node:http';
import net from 'node:net';

describe('health', () => {
  it('waitForHttp resolve quando o endpoint responde <500', async () => {
    const srv = http.createServer((_, res) => { res.statusCode = 200; res.end('ok'); }).listen(0);
    const port = srv.address().port;
    await expect(waitForHttp(`http://127.0.0.1:${port}/`, 2000)).resolves.toBe(true);
    srv.close();
  });
  it('waitForHttp rejeita se nunca responde', async () => {
    await expect(waitForHttp('http://127.0.0.1:1/', 800)).rejects.toThrow();
  });

  it('tcpAlive resolve true quando a porta aceita conexão', async () => {
    const srv = net.createServer((s) => s.end()).listen(0);
    const port = srv.address().port;
    await expect(tcpAlive('127.0.0.1', port, 1000)).resolves.toBe(true);
    srv.close();
  });
  it('tcpAlive resolve false (sem lançar) quando nada escuta na porta', async () => {
    const srv = net.createServer().listen(0);
    const port = srv.address().port;
    await new Promise((r) => srv.close(r)); // libera a porta antes do probe
    await expect(tcpAlive('127.0.0.1', port, 500)).resolves.toBe(false);
  });
});

describe('health completo do instalador', () => {
  const complete = () => ({
    storage: { running: true },
    peers: ['postgres', 'postgrest', 'gotrue', 'gateway', 'app', 'events', 'frontdoor']
      .map((name) => ({ name, running: true })),
    agent: {
      startupMode: 'interactive_logon',
      survivesRebootWithoutLogon: false,
      running: true,
      hiper: {
        connected: true,
        queryOk: true,
        schemaCompatible: true,
        targetSchema: 'Hiper Loja 197',
      },
    },
    sync: { enabled: true, lastError: null },
  });

  it('aceita storage, peers essenciais, Agent/Hiper e sync saudáveis', () => {
    expect(assertCompleteHubStatus(complete())).toBe(true);
  });

  it.each([
    ['storage', (s) => { s.storage.running = false; }],
    ['peer', (s) => { s.peers[0].running = false; }],
    ['Agent', (s) => { s.agent.running = false; }],
    ['Hiper', (s) => { s.agent.hiper.queryOk = false; }],
    ['schema Hiper alvo', (s) => { s.agent.hiper.targetSchema = 'Hiper Loja 195'; }],
    ['sync', (s) => { s.sync.lastError = 'cloud bloqueado'; }],
  ])('rejeita status incompleto em %s', (_, mutate) => {
    const status = complete();
    mutate(status);
    expect(() => assertCompleteHubStatus(status)).toThrow();
  });

  it('não confunde heartbeat fresco do processo com consulta Hiper falhando', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    const status = projectAgentReadiness({
      pid: 197,
      checkedAt: '2026-07-14T11:59:55.000Z',
      agentVersion: '1.1.0',
      hiper: {
        connected: true,
        queryOk: false,
        schemaCompatible: false,
        targetSchema: 'Hiper Loja 197',
        error: 'coluna ausente',
      },
    }, { now, maxAgeMs: 30_000 });

    expect(status.running).toBe(true);
    expect(status.hiper.queryOk).toBe(false);
    expect(status.hiper.schemaCompatible).toBe(false);
  });
});
