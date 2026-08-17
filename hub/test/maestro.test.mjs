import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildAgentStatus,
  needsInitdb,
  resolveAppEntrypoint,
  readPointerSync,
  currentAppVersion,
  stopSupervisorsSequentially,
} from '../maestro.mjs';

describe('needsInitdb', () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('true quando o data dir nao tem PG_VERSION (cluster nao inicializado)', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'pgdata-'));
    dirs.push(d);
    expect(needsInitdb(d)).toBe(true);
  });

  it('false quando ja existe PG_VERSION (cluster valido)', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'pgdata-'));
    dirs.push(d);
    writeFileSync(path.join(d, 'PG_VERSION'), '16\n');
    expect(needsInitdb(d)).toBe(false);
  });

  it('true para caminho ausente/vazio', () => {
    expect(needsInitdb('')).toBe(true);
    expect(needsInitdb(undefined)).toBe(true);
  });
});

describe('resolveAppEntrypoint', () => {
  const ROOT = '/x/exped';
  const installer = path.join(ROOT, 'app', 'server.js');
  const dev = path.join(ROOT, '.next', 'standalone', 'server.js');

  it('prefere app/server.js (layout do instalador) quando existe', () => {
    const exists = (p) => p === installer;
    expect(resolveAppEntrypoint(ROOT, null, null, exists)).toBe(installer);
  });

  it('usa .next/standalone/server.js (dev) quando o do instalador nao existe', () => {
    const exists = (p) => p === dev;
    expect(resolveAppEntrypoint(ROOT, null, null, exists)).toBe(dev);
  });

  it('prefere o do instalador quando ambos existem', () => {
    const exists = () => true;
    expect(resolveAppEntrypoint(ROOT, null, null, exists)).toBe(installer);
  });

  it('cai no layout dev quando nenhum existe (mensagem de erro aponta o esperado)', () => {
    const exists = () => false;
    expect(resolveAppEntrypoint(ROOT, null, null, exists)).toBe(dev);
  });
});

describe('resolveAppEntrypoint com ponteiro', () => {
  const root = '/srv';
  const rel = '/srv/releases';
  it('ponteiro presente + release existe → releases/<v>/server.js', () => {
    const exists = (p) => p === path.join(rel, '1.2.0', 'server.js');
    expect(resolveAppEntrypoint(root, rel, '1.2.0', exists)).toBe(path.join(rel, '1.2.0', 'server.js'));
  });
  it('ponteiro presente mas release não existe → app/server.js', () => {
    const exists = (p) => p === path.join(root, 'app', 'server.js');
    expect(resolveAppEntrypoint(root, rel, '1.2.0', exists)).toBe(path.join(root, 'app', 'server.js'));
  });
  it('sem ponteiro → app/server.js quando existe', () => {
    const exists = (p) => p === path.join(root, 'app', 'server.js');
    expect(resolveAppEntrypoint(root, rel, null, exists)).toBe(path.join(root, 'app', 'server.js'));
  });
  it('sem ponteiro e sem app → dev standalone', () => {
    const exists = () => false;
    expect(resolveAppEntrypoint(root, rel, null, exists)).toBe(path.join(root, '.next', 'standalone', 'server.js'));
  });
});

describe('readPointerSync', () => {
  it('lê e trima o ponteiro; ausente → null', () => {
    expect(readPointerSync('/x', () => '  1.2.0\n')).toBe('1.2.0');
    expect(readPointerSync('/x', () => { throw new Error('enoent'); })).toBe(null);
    expect(readPointerSync('/x', () => '   ')).toBe(null);
  });
});

describe('currentAppVersion', () => {
  it('ponteiro tem precedência; senão cfg.version; senão 0.0.0', () => {
    expect(currentAppVersion('1.3.0', '1.0.0')).toBe('1.3.0');
    expect(currentAppVersion(null, '1.0.0')).toBe('1.0.0');
    expect(currentAppVersion(null, undefined)).toBe('0.0.0');
  });
});

describe('/status do Agent', () => {
  it('expõe interactive_logon e não promete recuperação pré-login', async () => {
    const cfg = {
      startupMode: 'interactive_logon',
      survivesRebootWithoutLogon: false,
      healthPath: 'C:\\ProgramData\\ExpedAgent\\health.json',
      healthMaxAgeMs: 90_000,
      syncNowPort: 5005,
    };
    const status = await buildAgentStatus(cfg, async () => ({
      running: true,
      pid: 197,
      hiper: { connected: true, queryOk: true, schemaCompatible: true },
    }));

    expect(status.startupMode).toBe('interactive_logon');
    expect(status.survivesRebootWithoutLogon).toBe(false);
    expect(status.recovery.guaranteedBeforeLogon).toBe(false);
    expect(status.running).toBe(true);
    expect(status.hiper.queryOk).toBe(true);
  });
});

describe('shutdown sequencial', () => {
  it('aguarda cada peer em ordem inversa antes do pg_ctl', async () => {
    const calls = [];
    const supervisors = Object.fromEntries(
      ['postgrest', 'gotrue', 'gateway', 'app', 'events', 'frontdoor']
        .map((name) => [name, { name }]),
    );

    const stopped = await stopSupervisorsSequentially(supervisors, async (supervisor) => {
      calls.push(`start:${supervisor.name}`);
      await Promise.resolve();
      calls.push(`done:${supervisor.name}`);
      return true;
    });

    expect(stopped).toEqual(['frontdoor', 'events', 'app', 'gateway', 'gotrue', 'postgrest']);
    expect(calls).toEqual(stopped.flatMap((name) => [`start:${name}`, `done:${name}`]));
  });
});
