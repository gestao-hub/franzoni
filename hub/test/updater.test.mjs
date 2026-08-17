import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireUpdateLock,
  isNewer,
  checkAndUpdate,
  resolveUpdatePaths,
  validVersion,
} from '../updater.mjs';

describe('updater.validVersion', () => {
  it('aceita versões semver simples', () => {
    expect(validVersion('1.2.3')).toBe(true);
    expect(validVersion('1.2')).toBe(true);
    expect(validVersion('1')).toBe(true);
  });
  it('rejeita injeção de comando', () => {
    expect(validVersion('1.2.3; rm -rf /')).toBe(false);
  });
  it('rejeita path traversal', () => {
    expect(validVersion('../x')).toBe(false);
  });
  it('rejeita vazio/lixo', () => {
    expect(validVersion('')).toBe(false);
    expect(validVersion('v1.2.3')).toBe(false);
    expect(validVersion('1.2.3.4')).toBe(false);
    expect(validVersion(undefined)).toBe(false);
  });
});

describe('updater.isNewer', () => {
  it('detecta versão mais nova (semver)', () => {
    expect(isNewer('1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
    expect(isNewer('1.0.0', '1.2.0')).toBe(false);
  });
});

describe('updater.checkAndUpdate', () => {
  it('no-op quando não há manifestUrl', async () => {
    const res = await checkAndUpdate({}, {
      getCurrentVersion: () => '1.0.0',
      restart: async () => {},
      health: async () => {},
      logger: { info() {}, error() {} },
    });
    expect(res).toEqual({ updated: false, reason: 'sem manifest' });
  });

  it('no-op quando a versão do manifesto não é mais nova', async () => {
    let restarts = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '2.0.0',
        restart: async () => { restarts++; },
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      { fetchManifest: async () => ({ versao: '1.5.0', url: 'http://x/a.zip', sha256: 'abc' }) },
    );
    expect(res.updated).toBe(false);
    expect(restarts).toBe(0);
  });

  it('aborta sem trocar quando o sha256 não bate', async () => {
    let pointer = '1.0.0';
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'sha-esperado' }),
        download: async () => {},
        verifySha: async () => 'sha-DIFERENTE',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );
    expect(res).toEqual({ updated: false, reason: 'sha mismatch' });
    expect(pointer).toBe('1.0.0');
  });

  it('atualiza com sucesso quando health passa', async () => {
    let pointer = '1.0.0';
    const restartCalls = [];
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => { restartCalls.push(pointer); },
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );
    expect(res).toEqual({ updated: true, versao: '1.1.0' });
    expect(pointer).toBe('1.1.0');
    expect(restartCalls.length).toBe(1);
  });

  it('rejeita manifesto com versão inválida sem baixar/extrair', async () => {
    let downloaded = false;
    let extracted = false;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({ versao: '1.1.0; rm -rf /', url: 'http://x/a.zip', sha256: 'ok' }),
        download: async () => { downloaded = true; },
        verifySha: async () => 'ok',
        extract: async () => { extracted = true; },
        setPointer: async () => {},
        getPointer: async () => '1.0.0',
      },
    );
    expect(res.updated).toBe(false);
    expect(res.reason).toBe('versão inválida');
    expect(downloaded).toBe(false);
    expect(extracted).toBe(false);
  });

  it('faz rollback (restart 2x) quando o health da nova versão lança', async () => {
    let pointer = '1.0.0';
    let restarts = 0;
    let healthChecks = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => { restarts++; },
        health: async () => {
          healthChecks++;
          if (healthChecks === 1) throw new Error('app não respondeu');
        },
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );
    expect(res.updated).toBe(false);
    expect(res.rolledBack).toBe(true);
    // trocou pra 1.1.0 e voltou pro 1.0.0 anterior
    expect(pointer).toBe('1.0.0');
    // restart chamado 2x: troca + volta
    expect(restarts).toBe(2);
    expect(healthChecks).toBe(2);
  });

  it('também reverte quando o restart da versão nova falha', async () => {
    let pointer = '1.0.0';
    let restarts = 0;
    let healthChecks = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => {
          restarts++;
          if (restarts === 1) throw new Error('restart novo falhou');
        },
        health: async () => { healthChecks++; },
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );
    expect(res).toEqual({ updated: false, rolledBack: true });
    expect(pointer).toBe('1.0.0');
    expect(restarts).toBe(2);
    expect(healthChecks).toBe(1);
  });

  it('não afirma rollback quando restart ou health restaurado falha', async () => {
    const run = async ({ failRollbackRestart = false, failRollbackHealth = false }) => {
      let pointer = '1.0.0';
      let restarts = 0;
      let healthChecks = 0;
      let failure;
      try {
        await checkAndUpdate(
          { manifestUrl: 'http://x/manifest.json' },
          {
          getCurrentVersion: () => '1.0.0',
          restart: async () => {
            restarts++;
            if (restarts === 2 && failRollbackRestart) throw new Error('restart rollback falhou');
          },
          health: async () => {
            healthChecks++;
            if (healthChecks === 1 || failRollbackHealth) throw new Error('health falhou');
          },
          logger: { info() {}, error() {} },
          },
          {
          fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
          download: async () => {},
          verifySha: async () => 'ok',
          extract: async () => {},
          setPointer: async (v) => { pointer = v; },
          getPointer: async () => pointer,
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure?.message).toMatch(/rollback não foi comprovado/i);
      expect(pointer).toBe('1.0.0');
    };
    await run({ failRollbackRestart: true });
    await run({ failRollbackHealth: true });
  });
});

describe('updater.checkAndUpdate migrate', () => {
  const baseDeps = {
    fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
    download: async () => {},
    verifySha: async () => 'ok',
    extract: async () => {},
  };
  it('chama migrate(releaseDir) depois de extrair e antes de restart; sucesso', async () => {
    const order = [];
    let pointer = '1.0.0';
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/m.json', paths: { releasesDir: '/r' } },
      {
        getCurrentVersion: () => '1.0.0',
        migrate: async (dir) => { order.push(`migrate:${dir}`); },
        restart: async () => { order.push('restart'); },
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        ...baseDeps,
        extract: async () => { order.push('extract'); },
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );
    expect(res).toEqual({ updated: true, versao: '1.1.0' });
    const iMig = order.findIndex((s) => s.startsWith('migrate:'));
    const iRes = order.indexOf('restart');
    expect(iMig).toBeGreaterThan(order.indexOf('extract'));
    expect(iMig).toBeLessThan(iRes);
    expect(order[iMig]).toBe('migrate:/r/1.1.0');
  });
  it('rollback no health-fail NÃO chama migrate de novo', async () => {
    let migrates = 0;
    let pointer = '1.0.0';
    let healthChecks = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/m.json', paths: { releasesDir: '/r' } },
      {
        getCurrentVersion: () => '1.0.0',
        migrate: async () => { migrates++; },
        restart: async () => {},
        health: async () => {
          healthChecks++;
          if (healthChecks === 1) throw new Error('health falhou');
        },
        logger: { info() {}, error() {} },
      },
      { ...baseDeps, setPointer: async (v) => { pointer = v; }, getPointer: async () => pointer },
    );
    expect(res).toEqual({ updated: false, rolledBack: true });
    expect(migrates).toBe(1); // só na ida, não no rollback
  });
});

describe('updater paths Windows', () => {
  it('resolve paths relativos contra C:\\Exped, nunca contra o cwd', () => {
    const resolved = resolveUpdatePaths({
      paths: { releasesDir: 'releases', releasesPtr: 'releases/current' },
    }, { platform: 'win32', root: 'C:\\Exped', cwd: 'C:\\Windows\\System32' });

    expect(resolved.releasesDir).toBe('C:\\Exped\\releases');
    expect(resolved.ptrPath).toBe('C:\\Exped\\releases\\current');
    expect(resolved.lockPath.startsWith('C:\\Exped\\')).toBe(true);
    expect(resolved.lockPath).not.toContain('System32');
  });
});

describe('updater lock com lease', () => {
  it('usa token de owner, heartbeat e compare-and-delete no release', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'exped-updater-lock-'));
    const lockPath = path.join(root, '.update-lock');
    const lease = await acquireUpdateLock(lockPath, {
      heartbeatMs: 20,
      staleMs: 5_000,
    });
    try {
      expect(lease.acquired).toBe(true);
      const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
      const heartbeatPath = path.join(lockPath, `heartbeat-${lease.token}.json`);
      const first = JSON.parse(await readFile(heartbeatPath, 'utf8'));
      expect(owner.token).toBe(lease.token);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = JSON.parse(await readFile(heartbeatPath, 'utf8'));
      expect(Date.parse(second.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(first.heartbeatAt));

      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
        token: 'outro-owner',
        heartbeatAt: new Date().toISOString(),
      }));
      await expect(lease.release()).resolves.toBe(false);
      await expect(readFile(path.join(lockPath, 'owner.json'), 'utf8')).resolves.toContain('outro-owner');
    } finally {
      await lease.stopHeartbeat?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('impede dois updates concorrentes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'exped-updater-concurrent-'));
    const cfg = {
      manifestUrl: 'http://x/m.json',
      paths: { root, releasesDir: 'releases', releasesPtr: 'releases/current' },
    };
    await mkdir(path.join(root, 'releases'), { recursive: true });
    let fetched = 0;
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    const deps = {
      fetchManifest: async () => {
        fetched++;
        await gate;
        return { versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' };
      },
      download: async () => {},
      verifySha: async () => 'ok',
      extract: async () => {},
      lockOptions: { heartbeatMs: 20, staleMs: 5_000 },
    };
    const callbacks = {
      getCurrentVersion: () => '1.0.0',
      restart: async () => {},
      health: async () => {},
      logger: { info() {}, error() {} },
    };

    try {
      const first = checkAndUpdate(cfg, callbacks, deps);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await checkAndUpdate(cfg, callbacks, deps);
      expect(second).toMatchObject({ updated: false, reason: 'update locked' });
      expect(fetched).toBe(1);
      unblock();
      await expect(first).resolves.toMatchObject({ updated: true });
    } finally {
      unblock?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});
