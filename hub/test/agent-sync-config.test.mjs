import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function routine(text, name) {
  const start = text.search(new RegExp(`^(?:function|procedure)\\s+${name}\\b`, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^\s*(?:function|procedure)\s+[\w-]+\b/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('identidade operacional do Agent', () => {
  it('instala, configura e inicia sob o token do usuário original comprovado', () => {
    const setup = source('../win/exped-setup.iss');
    const originalUserWrapper = routine(setup, 'ExecOriginalUserChecked');
    const install = routine(setup, 'RunTransactionalInstall');
    const helper = source('../win/agent-user-install.ps1');

    expect(originalUserWrapper).toContain('ExecAsOriginalUser');
    expect(helper).toContain('Get-VerifiedInteractiveUserSid');
    expect(helper).toContain('GetOwnerSid');
    expect(helper).toContain('InstallReceipts');
    expect(helper).toContain('Get-ExpedFileOwnerSid');

    const provision = install.indexOf('provision.ps1');
    const installUser = install.indexOf("'-Install -Root");
    const installHub = install.indexOf('install-service.ps1');
    const startUser = install.indexOf("'-Start -Root");
    expect([provision, installUser, installHub, startUser].every((i) => i >= 0)).toBe(true);
    expect([provision, installUser, installHub, startUser]).toEqual(
      [...[provision, installUser, installHub, startUser]].sort((a, b) => a - b),
    );
    expect(install.match(/ExecOriginalUserChecked/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('cleanup por tarefa interativa prova SID/path/owner e falha fechado antes do Hub', () => {
    const uninstall = source('../win/uninstall-service.ps1');
    const helper = source('../win/agent-user-install.ps1');

    expect(uninstall).toContain('TASK_LOGON_INTERACTIVE_TOKEN');
    expect(uninstall).toContain('ExpectedUserSid');
    expect(uninstall).toContain('ExpectedSettingsPath');
    expect(uninstall).toContain('UninstallReceipts');
    expect(uninstall).toContain('Get-ExpedFileOwnerSid');
    expect(helper).toMatch(/ExpectedUserSid[\s\S]*Get-VerifiedInteractiveUserSid/);
    expect(helper).toMatch(/Remove-Item[^\r\n]*startupVbs/);
    expect(helper).toMatch(/Remove-Item[^\r\n]*agentDir/);

    const guard = uninstall.indexOf('if (-not $agentCleanupComplete)');
    const teardown = uninstall.indexOf('if (Test-Path $Nssm)');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(teardown);
    expect(uninstall.slice(guard, teardown)).toMatch(/exit\s+2/);
  });

  it('propaga ports.app ao ApiBaseUrl do Agent', () => {
    const helper = source('../win/agent-user-install.ps1');
    expect(helper).toMatch(/ports\.app[\s\S]*ApiBaseUrl/i);
    expect(helper).not.toMatch(/ApiBaseUrl\s+'http:\/\/127\.0\.0\.1:3000'/);
  });
});
