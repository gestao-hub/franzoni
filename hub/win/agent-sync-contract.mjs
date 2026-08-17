import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SYNC_NOW_PORT = 5005;

function validPort(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${label} deve ser um inteiro entre 0 e 65535`);
  }
  return value;
}
function validSid(value, label = 'userSid') {
  const sid = String(value || '').trim();
  if (!/^S-\d-(?:\d+-)+\d+$/i.test(sid)) {
    throw new Error(`${label} deve ser um SID Windows`);
  }
  return sid;
}

export function resolveSyncNowPort(config = {}) {
  const value = config.agent?.syncNowPort ?? DEFAULT_SYNC_NOW_PORT;
  return validPort(value, 'agent.syncNowPort');
}

export function syncNowUrl(port) {
  const value = validPort(port, 'syncNowPort');
  return value === 0 ? null : `http://127.0.0.1:${value}/`;
}

export function urlAclSddl(userSid) {
  return `D:(A;;GX;;;${validSid(userSid)})`;
}

export function reservationMatchesExpectedSddl(showOutput, expectedSddl) {
  const expected = String(expectedSddl || '').trim();
  if (!expected.startsWith('D:(')) return false;

  for (const line of String(showOutput || '').split(/\r?\n/)) {
    const descriptorIndex = line.toUpperCase().indexOf('D:(');
    if (descriptorIndex === -1) continue;
    const actual = line.slice(descriptorIndex).trim();
    return actual.localeCompare(expected, undefined, { sensitivity: 'accent' }) === 0;
  }
  return false;
}

function showArgs(port) {
  return ['http', 'show', 'urlacl', `url=${syncNowUrl(port)}`];
}

function deleteStep(port, userSid) {
  return {
    action: 'delete',
    args: ['http', 'delete', 'urlacl', `url=${syncNowUrl(port)}`],
    showArgs: showArgs(port),
    expectedSddl: urlAclSddl(userSid),
    tolerateMissing: true,
  };
}

function addArgs(port, userSid) {
  return ['http', 'add', 'urlacl', `url=${syncNowUrl(port)}`, `sddl=${urlAclSddl(userSid)}`];
}

function addStep(port, userSid, rollbackUserSid) {
  const step = {
    action: 'add',
    args: addArgs(port, userSid),
    showArgs: showArgs(port),
    expectedSddl: urlAclSddl(userSid),
  };
  if (rollbackUserSid) {
    step.rollbackArgs = addArgs(port, rollbackUserSid);
    step.rollbackExpectedSddl = urlAclSddl(rollbackUserSid);
  }
  return step;
}

export function planUrlAclTransition({
  previousPort,
  previousUserSid,
  desiredPort,
  userSid,
}) {
  const before = previousPort === undefined || previousPort === null || previousPort === ''
    ? 0
    : validPort(previousPort, 'previousPort');
  const after = validPort(desiredPort, 'desiredPort');
  const oldSid = before > 0 ? validSid(previousUserSid, 'previousUserSid') : null;

  if (after === 0) return before === 0 ? [] : [deleteStep(before, oldSid)];

  const nextSid = validSid(userSid);
  if (before === 0) return [addStep(after, nextSid)];

  if (before === after) {
    if (oldSid?.toUpperCase() === nextSid.toUpperCase()) {
      return [{
        action: 'ensure',
        showArgs: showArgs(after),
        addArgs: addArgs(after, nextSid),
        expectedSddl: urlAclSddl(nextSid),
      }];
    }
    return [deleteStep(before, oldSid), addStep(after, nextSid, oldSid)];
  }

  // Reserve the destination first. If it is occupied, netsh fails and the old
  // reservation remains intact.
  return [addStep(after, nextSid), deleteStep(before, oldSid)];
}

function validSettingsPath(value, label) {
  const settingsPath = String(value || '').trim();
  if (
    !path.win32.isAbsolute(settingsPath)
    || path.win32.basename(settingsPath).toLowerCase() !== 'appsettings.json'
  ) {
    throw new Error(`${label} deve ser um caminho Windows absoluto para appsettings.json`);
  }
  return path.win32.normalize(settingsPath);
}

export function validateAgentReceiptTransition({
  existingSettingsPath,
  existingUserSid,
  existingSettingsOwnerSid,
  receiptSettingsPath,
  receiptUserSid,
}) {
  const settingsPath = validSettingsPath(receiptSettingsPath, 'receiptSettingsPath');
  const userSid = validSid(receiptUserSid, 'receiptUserSid');

  if (existingUserSid && !existingSettingsPath) {
    throw new Error('Metadados do agente estao incompletos; desinstale o agente anterior ou migre explicitamente.');
  }

  let currentSid;
  if (existingSettingsPath) {
    const currentPath = validSettingsPath(existingSettingsPath, 'existingSettingsPath');
    if (currentPath.toUpperCase() !== settingsPath.toUpperCase()) {
      throw new Error('O agente instalado usa outro settingsPath; desinstale o agente anterior ou migre explicitamente.');
    }
    if (existingUserSid) {
      currentSid = validSid(existingUserSid, 'existingUserSid');
    } else {
      if (!existingSettingsOwnerSid) {
        throw new Error('Config legado sem userSid exige o owner SID exato de existingSettingsPath.');
      }
      currentSid = validSid(existingSettingsOwnerSid, 'existingSettingsOwnerSid');
    }
  }
  if (currentSid) {
    if (currentSid.toUpperCase() !== userSid.toUpperCase()) {
      throw new Error('O agente instalado pertence a outro SID; desinstale o agente anterior ou migre explicitamente.');
    }
  }

  return { settingsPath, userSid };
}

function optionalPort(value) {
  return value === undefined || value === '' ? undefined : Number(value);
}

function runCli(argv) {
  const [command, ...args] = argv;
  const optionalValue = (value) => (value && value !== '-' ? value : undefined);

  if (command === 'urlacl-plan') {
    const [previousPort, previousUserSid, desiredPort, userSid] = args;
    const plan = planUrlAclTransition({
      previousPort: optionalPort(previousPort),
      previousUserSid: optionalValue(previousUserSid),
      desiredPort: Number(desiredPort),
      userSid: optionalValue(userSid),
    });
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }

  if (command === 'receipt-transition') {
    const [
      existingSettingsPath,
      existingUserSid,
      existingSettingsOwnerSid,
      receiptSettingsPath,
      receiptUserSid,
    ] = args;
    const transition = validateAgentReceiptTransition({
      existingSettingsPath: optionalValue(existingSettingsPath),
      existingUserSid: optionalValue(existingUserSid),
      existingSettingsOwnerSid: optionalValue(existingSettingsOwnerSid),
      receiptSettingsPath,
      receiptUserSid,
    });
    process.stdout.write(`${JSON.stringify(transition)}\n`);
    return;
  }

  throw new Error('uso: urlacl-plan ... | receipt-transition ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
