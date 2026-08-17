// Auto-update do Hub Exped com rollback.
//
// Fluxo (checkAndUpdate):
//   1. sem cfg.manifestUrl            -> no-op.
//   2. GET manifest { versao,url,sha256 }.
//   3. versao não é mais nova         -> no-op.
//   4. baixa url -> releases/<versao>.zip, valida sha256; mismatch -> aborta.
//   5. extrai -> releases/<versao>/, aponta ponteiro `current` pra <versao>, restart().
//   6. health(); ok -> {updated:true}. Lançou -> reverte ponteiro pro anterior,
//      restart() de novo, {updated:false, rolledBack:true}.
//
// A LÓGICA é testável injetando deps (fetchManifest/download/verifySha/extract/
// setPointer/getPointer) e os callbacks (getCurrentVersion/restart/health). Os
// defaults fazem o I/O real (node:crypto, fetch, unzip via tar/PowerShell).

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

function pathApi(platform, value = '') {
  return platform === 'win32' || /^[A-Za-z]:[\\/]/.test(value) ? path.win32 : path;
}

function resolveFromRoot(root, value, platform) {
  const api = pathApi(platform, root || value);
  if (api.isAbsolute(value)) return api.normalize(value);
  return api.resolve(root, value);
}

export function resolveUpdatePaths(cfg = {}, options = {}) {
  const platform = options.platform || process.platform;
  const root = options.root || cfg.paths?.root ||
    (platform === 'win32' ? 'C:\\Exped' : process.cwd());
  const api = pathApi(platform, root);
  const releasesDir = resolveFromRoot(root, cfg.paths?.releasesDir || 'releases', platform);
  const ptrPath = resolveFromRoot(
    root,
    cfg.paths?.releasesPtr || api.join('releases', 'current'),
    platform,
  );
  const lockPath = resolveFromRoot(
    root,
    cfg.paths?.updateLock || api.join('releases', '.update-lock'),
    platform,
  );
  return { root: api.normalize(root), releasesDir, ptrPath, lockPath };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readLockIdentity(lockPath) {
  return readJson(path.join(lockPath, 'owner.json'));
}

async function readLockOwner(lockPath) {
  const identity = await readLockIdentity(lockPath);
  if (!identity?.token) return identity;
  const heartbeat = await readJson(path.join(lockPath, `heartbeat-${identity.token}.json`));
  return { ...identity, heartbeatAt: heartbeat?.heartbeatAt || identity.heartbeatAt };
}

async function writeLockIdentity(lockPath, owner) {
  const temp = path.join(lockPath, `owner-${owner.token}.tmp`);
  await writeFile(temp, JSON.stringify(owner), { encoding: 'utf8', flag: 'w' });
  await rename(temp, path.join(lockPath, 'owner.json'));
}

async function writeLockHeartbeat(lockPath, token, heartbeatAt) {
  const temp = path.join(lockPath, `heartbeat-${token}-${randomUUID()}.tmp`);
  const target = path.join(lockPath, `heartbeat-${token}.json`);
  await writeFile(temp, JSON.stringify({ token, heartbeatAt }), { encoding: 'utf8', flag: 'w' });
  await rename(temp, target);
}

export async function acquireUpdateLock(lockPath, options = {}) {
  const heartbeatMs = options.heartbeatMs || 5_000;
  const staleMs = options.staleMs || 60_000;
  const token = options.token || randomUUID();
  const parent = path.dirname(lockPath);
  await mkdir(parent, { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
    try {
      await mkdir(lockPath);
      acquired = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const observed = await readLockOwner(lockPath);
      const heartbeatAt = Date.parse(observed?.heartbeatAt || '');
      if (!observed?.token || !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt <= staleMs) {
        return { acquired: false, reason: 'update locked' };
      }

      const stalePath = `${lockPath}.stale-${token}`;
      try {
        await rename(lockPath, stalePath);
      } catch (renameError) {
        if (renameError?.code === 'ENOENT' || renameError?.code === 'EEXIST') continue;
        throw renameError;
      }
      const moved = await readLockOwner(stalePath);
      const movedHeartbeat = Date.parse(moved?.heartbeatAt || '');
      const sameStaleOwner =
        moved?.token === observed.token &&
        Number.isFinite(movedHeartbeat) &&
        Date.now() - movedHeartbeat > staleMs;
      if (!sameStaleOwner) {
        await rename(stalePath, lockPath).catch(() => {});
        return { acquired: false, reason: 'update locked' };
      }
      await rm(stalePath, { recursive: true, force: true });
    }
  }

  if (!acquired) return { acquired: false, reason: 'update locked' };

  let timer = null;
  let heartbeatPromise = Promise.resolve();
  let lostError = null;
  const owner = () => ({ token, pid: process.pid, heartbeatAt: new Date().toISOString() });
  try {
    const initial = owner();
    await writeLockIdentity(lockPath, initial);
    await writeLockHeartbeat(lockPath, token, initial.heartbeatAt);
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }

  const assertOwned = async () => {
    if (lostError) throw lostError;
    const current = await readLockIdentity(lockPath);
    if (current?.token !== token) throw new Error('update lock ownership lost');
    return true;
  };
  const heartbeat = async () => {
    await assertOwned();
    await writeLockHeartbeat(lockPath, token, new Date().toISOString());
    await assertOwned();
  };
  timer = setInterval(() => {
    heartbeatPromise = heartbeat().catch((error) => { lostError = error; });
  }, heartbeatMs);
  timer.unref?.();

  const stopHeartbeat = async () => {
    if (timer) clearInterval(timer);
    timer = null;
    await heartbeatPromise.catch(() => {});
  };
  const release = async () => {
    await stopHeartbeat();
    const current = await readLockIdentity(lockPath);
    if (current?.token !== token) return false;
    const releasePath = `${lockPath}.release-${token}`;
    try {
      await rename(lockPath, releasePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    const claimed = await readLockIdentity(releasePath);
    if (claimed?.token !== token) {
      await rename(releasePath, lockPath).catch(() => {});
      return false;
    }
    await rm(releasePath, { recursive: true, force: true });
    return true;
  };

  return { acquired: true, token, assertOwned, stopHeartbeat, release };
}

/**
 * Valida que `v` é um semver "limpo" (1, 1.2 ou 1.2.3), só dígitos e pontos.
 * Bloqueia injeção de comando / path traversal (`; rm`, `../`, etc.) antes de
 * a versão ser usada pra montar paths ou args de processo.
 */
export function validVersion(v) {
  return typeof v === 'string' && /^[0-9]+(\.[0-9]+){0,2}$/.test(v);
}

/** Parse "1.2.3" -> [1,2,3]; segmentos ausentes/NaN viram 0. */
function parseSemver(v) {
  return String(v)
    .trim()
    .replace(/^v/, '')
    .split('.')
    .slice(0, 3)
    .map((n) => {
      const x = parseInt(n, 10);
      return Number.isFinite(x) ? x : 0;
    });
}

/** true se semver `a` > `b` (compara major/minor/patch numericamente). */
export function isNewer(a, b) {
  const [aM, aMi, aP] = parseSemver(a);
  const [bM, bMi, bP] = parseSemver(b);
  if (aM !== bM) return aM > bM;
  if (aMi !== bMi) return aMi > bMi;
  return aP > bP;
}

// --------------------------------------------------------------------------
// I/O real (deps default) — funções pequenas, substituíveis nos testes.
// --------------------------------------------------------------------------

/** GET JSON do manifesto. */
async function defaultFetchManifest(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  return res.json();
}

/** baixa `url` pro arquivo `dest`. */
async function defaultDownload(url, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** sha256 hex do arquivo `file`. */
async function defaultVerifySha(file) {
  const buf = await readFile(file);
  return createHash('sha256').update(buf).digest('hex');
}

/** extrai o zip `file` pra pasta `dir`. Usa tar (Win10+/Linux) com fallback PowerShell. */
async function defaultExtract(file, dir) {
  await mkdir(dir, { recursive: true });
  try {
    await execFileAsync('tar', ['-xf', file, '-C', dir], { maxBuffer: 1024 * 1024 * 64 });
  } catch {
    // fallback Windows (PowerShell Expand-Archive). Forma PARAMETRIZADA: os
    // paths vão como argumentos posicionais ($s/$d) via array de args (não shell
    // string), então não há interpolação nem injeção possível.
    await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '& {param($s,$d) Expand-Archive -Force -Path $s -DestinationPath $d}',
        '--',
        file,
        dir,
      ],
      { maxBuffer: 1024 * 1024 * 64 },
    );
  }
}

/**
 * Cria getPointer/setPointer reais ligados a `ptrPath`. Assinaturas:
 *   getPointer()        -> string|null  (versão atual apontada)
 *   setPointer(versao)  -> void
 * Os defaults e os mocks de teste compartilham essa mesma assinatura simples
 * (ptrPath fica encapsulado), o que mantém a injeção trivial.
 */
function makePointerIO(ptrPath) {
  return {
    getPointer: async () => {
      try {
        return (await readFile(ptrPath, 'utf8')).trim() || null;
      } catch {
        return null;
      }
    },
    setPointer: async (versao) => {
      await mkdir(path.dirname(ptrPath), { recursive: true });
      await writeFile(ptrPath, String(versao), 'utf8');
    },
    clearPointer: async () => {
      await rm(ptrPath, { force: true });
    },
  };
}

async function rollbackActivatedRelease({
  previous,
  setPointer,
  clearPointer,
  restart,
  health,
  lease,
  updateError,
}) {
  const rollbackErrors = [];
  let pointerRestored = false;
  try {
    await lease.assertOwned?.();
    if (previous) await setPointer(previous);
    else await clearPointer();
    pointerRestored = true;
  } catch (error) {
    rollbackErrors.push(error);
  }

  if (pointerRestored) {
    try { await restart(); }
    catch (error) { rollbackErrors.push(error); }
    try { await health(); }
    catch (error) { rollbackErrors.push(error); }
  }

  if (rollbackErrors.length > 0) {
    const failure = new Error(
      `update falhou e rollback não foi comprovado: ${rollbackErrors.map((e) => e?.message).join('; ')}`,
      { cause: updateError },
    );
    failure.rollbackErrors = rollbackErrors;
    throw failure;
  }
  return { updated: false, rolledBack: true };
}

/**
 * Verifica o manifesto e, se houver versão mais nova, baixa/valida/extrai,
 * aplica migrations da release (aditivas/idempotentes), troca o ponteiro
 * `current`, reinicia e roda health. Se o health falhar, reverte o ponteiro
 * e reinicia (rollback) — sem chamar migrate novamente.
 *
 * @param {object} cfg                 config do hub (usa manifestUrl + paths.releasesPtr/releasesDir)
 * @param {object} cb                  { getCurrentVersion, restart, health, logger, migrate?(releaseDir) }
 * @param {object} [deps]              I/O injetável (defaults reais)
 */
export async function checkAndUpdate(cfg, cb, deps = {}) {
  const { getCurrentVersion, restart, health } = cb;
  const logger = cb.logger || console;

  if (!cfg.manifestUrl) return { updated: false, reason: 'sem manifest' };

  const { releasesDir, ptrPath, lockPath } = resolveUpdatePaths(cfg);
  const acquireLock = deps.acquireLock || acquireUpdateLock;
  const lease = await acquireLock(lockPath, deps.lockOptions);
  if (!lease.acquired) return { updated: false, reason: 'update locked' };

  try {
    const ptrIO = makePointerIO(ptrPath);
    const {
      fetchManifest = defaultFetchManifest,
      download = defaultDownload,
      verifySha = defaultVerifySha,
      extract = defaultExtract,
      setPointer = ptrIO.setPointer,
      getPointer = ptrIO.getPointer,
      clearPointer = deps.setPointer
        ? async () => deps.setPointer(null)
        : ptrIO.clearPointer,
    } = deps;

  // (2) manifesto
    const manifest = await fetchManifest(cfg.manifestUrl);
    const { versao, url, sha256 } = manifest;

  // (2.1) versao precisa ser semver limpo ANTES de virar path/arg de processo.
  // Bloqueia injeção de comando / path traversal sem baixar nem extrair nada.
    if (!validVersion(versao)) {
    logger.error?.(`[updater] versão inválida no manifesto: ${JSON.stringify(versao)}`);
      return { updated: false, reason: 'versão inválida' };
    }

  // (3) mais nova?
    if (!isNewer(versao, getCurrentVersion())) {
      return { updated: false };
    }
    logger.info?.(`[updater] versão ${versao} disponível (atual ${getCurrentVersion()})`);

  // (4) baixa + valida sha
    const zipPath = path.join(releasesDir, `${versao}.zip`);
    await download(url, zipPath);
    const got = await verifySha(zipPath);
    if (got !== sha256) {
    logger.error?.(`[updater] sha mismatch: esperado ${sha256}, obtido ${got}`);
    await rm(zipPath, { force: true }).catch(() => {});
      return { updated: false, reason: 'sha mismatch' };
    }

  // (5) extrai + (migrate aditivo) + troca ponteiro + restart
    const previous = await getPointer();
    const releaseDir = path.join(releasesDir, versao);
    await extract(zipPath, releaseDir);
    if (cb.migrate) await cb.migrate(releaseDir); // migrations da release (aditivas, idempotentes)
    await lease.assertOwned?.();
    await setPointer(versao);

  // (6) restart + health -> rollback verificado se qualquer etapa falhar
    try {
      await restart();
      await health();
      logger.info?.(`[updater] atualizado para ${versao}`);
      return { updated: true, versao };
    } catch (err) {
      logger.error?.(`[updater] ativação falhou (${err?.message}); revertendo para ${previous || '<base>'}`);
      return await rollbackActivatedRelease({
        previous,
        setPointer,
        clearPointer,
        restart,
        health,
        lease,
        updateError: err,
      });
    }
  } finally {
    await lease.release();
  }
}

export default { isNewer, checkAndUpdate, acquireUpdateLock, resolveUpdatePaths };
