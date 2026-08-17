import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function routine(text, name) {
  const start = text.search(new RegExp(`^(?:function|procedure)\\s+${name}\\b`, 'mi'));
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^\s*(?:function|procedure)\s+[\w-]+\b/mi);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('hardening do instalador Windows', () => {
  const setup = source('../win/exped-setup.iss');
  const hubOnly = source('../win/exped-hub.iss');
  const install = source('../win/install-service.ps1');
  const orchestrator = existsSync(new URL('../win/installer-orchestrator.ps1', import.meta.url))
    ? source('../win/installer-orchestrator.ps1')
    : '';
  const download = source('../win/download-binaries.ps1');
  const workflow = source('../../.github/workflows/build-installer.yml');

  it('usa AppIds explícitos, distintos e compatíveis com os nomes legados', () => {
    const unifiedId = setup.match(/^AppId=(.+)$/m)?.[1].trim();
    const hubId = hubOnly.match(/^AppId=(.+)$/m)?.[1].trim();
    expect(unifiedId).toBe('Exped');
    expect(hubId).toBe('Exped Hub');
    expect(unifiedId).not.toBe(hubId);
    expect(setup).toMatch(/uninstall-service\.ps1[\s\S]*-ManageAgent true/);
    expect(hubOnly).toMatch(/uninstall-service\.ps1[\s\S]*-ManageAgent false/);
  });

  it('só finaliza snapshots depois de /status completo', () => {
    const installFlow = routine(setup, 'RunTransactionalInstall');
    const health = installFlow.indexOf("OrchestratorParams('VerifyCompleteStatus'");
    const provisionFinalize = installFlow.indexOf('-FinalizeTransaction');
    const hubFinalize = installFlow.indexOf("OrchestratorParams('FinalizeHub'");
    const agentFinalize = installFlow.indexOf("'-Finalize -Root");
    expect([health, provisionFinalize, hubFinalize, agentFinalize].every((i) => i >= 0)).toBe(true);
    expect([health, provisionFinalize, hubFinalize, agentFinalize]).toEqual(
      [...[health, provisionFinalize, hubFinalize, agentFinalize]].sort((a, b) => a - b),
    );
    const verify = routine(orchestrator, 'Assert-CompleteHubStatus');
    for (const marker of [
      'storage', 'postgres', 'postgrest', 'gotrue', 'gateway', 'app', 'events',
      'frontdoor', 'interactive_logon', 'survivesRebootWithoutLogon', 'hiper',
      'queryOk', 'schemaCompatible', 'sync', 'lastError',
    ]) expect(verify).toContain(marker);
  });

  it('usa Invoke-WebRequest compatível com Windows PowerShell 5.1', () => {
    const scripts = [download, install, orchestrator];
    for (const script of scripts) {
      const calls = script.match(/Invoke-WebRequest[^\r\n]*/g) || [];
      for (const call of calls) expect(call).toContain('-UseBasicParsing');
    }
    expect(workflow).toMatch(/shell:\s*powershell[\s\S]*PSVersionTable\.PSVersion\.Major[\s\S]*-ne 5/i);
    expect(workflow).toContain('Language.Parser]::ParseFile');
  });

  it('protege config.json transacionalmente por SID e restringe firewall', () => {
    const protectAcl = routine(install, 'Protect-ExpedConfigAcl');
    expect(protectAcl).toContain('S-1-5-18');
    expect(protectAcl).toContain('S-1-5-32-544');
    expect(protectAcl).toContain('OperationalUserSid');
    expect(protectAcl).not.toMatch(/['"](?:BUILTIN\\)?(?:Users|Usuarios|Authenticated Users)['"]/i);
    expect(orchestrator).toContain('ConfigAclSddl');
    expect(orchestrator).toMatch(/SetSecurityDescriptorSddlForm\([^)]*ConfigAclSddl/s);

    expect(install).toMatch(/New-NetFirewallRule[\s\S]*-RemoteAddress\s+'?LocalSubnet'?/i);
    expect(install).toMatch(/-Profile\s+[^\r\n]*Domain[^\r\n]*Private/i);
    expect(install).not.toMatch(/-Profile\s+[^\r\n]*Public/i);
  });

  it('captura firewall fiel e não deixa falha dele interromper arquivos/serviço', () => {
    const capture = routine(orchestrator, 'Export-FirewallSnapshot');
    for (const marker of [
      'Direction', 'Action', 'Enabled', 'Profile', 'Protocol', 'LocalPort',
      'RemoteAddress', 'Program', 'Service', 'InterfaceType',
    ]) expect(capture).toContain(marker);

    const restore = routine(orchestrator, 'Restore-HubSnapshot');
    expect(restore).toMatch(/try[\s\S]*Restore-FirewallSnapshot[\s\S]*catch/i);
    expect(restore.indexOf('Restore-FirewallSnapshot')).toBeLessThan(restore.indexOf('Restore-HubServiceSnapshot'));
    expect(restore).toContain('Restore-HubServiceSnapshot');
  });

  it('seleciona IP físico/gateway e valida HTTPS', () => {
    const selectIp = routine(install, 'Resolve-ExpedServerIp');
    const validateIp = routine(install, 'Test-ExpedUsableIpv4');
    expect(selectIp).toContain('IPv4DefaultGateway');
    expect(selectIp).toMatch(/Hyper-V|vEthernet/i);
    expect(selectIp).toMatch(/VPN|TAP|TUN/i);
    expect(validateIp).toMatch(/169[\s\S]*254/);
    expect(validateIp).toContain('127');
    expect(selectIp).toContain('$ServerIp');
    expect(install).toMatch(/https:\/\/["$A-Za-z][^\r\n]*\/login[\s\S]*UseBasicParsing/i);
  });

  it('alinha timeout/métodos NSSM ao shutdown e pg_ctl', () => {
    expect(install).toMatch(/AppStopMethodConsole['"),\s]+60000/);
    expect(install).toMatch(/AppStopMethodSkip['"),\s]+0/);
    expect(install).toMatch(/AppKillProcessTree[\s\S]*\[int\]0[\s\S]*RegistryValueKind\]::DWord/);
    expect(install).toMatch(/AppStopMethodWindow/);
    expect(install).toMatch(/AppStopMethodThreads/);
  });

  it('inclui canário pré/pós-login, botão, sync, rollback e 03:00 pausado', () => {
    const canaryUrl = new URL('../win/windows-canary.ps1', import.meta.url);
    expect(existsSync(canaryUrl)).toBe(true);
    const canary = existsSync(canaryUrl) ? readFileSync(canaryUrl, 'utf8') : '';
    for (const marker of [
      'PreLogin', 'PostLogin', 'Sincronizar', '/status', 'sync', 'rollback',
      'Hiper Loja 195', 'Hiper Loja 197', 'pedido local', 'sync cloud',
    ]) expect(canary).toContain(marker);
    expect(canary).toMatch(/03:00[\s\S]*PAUSADO/i);
    expect(canary).not.toMatch(/New-ScheduledTaskTrigger\s+-Daily\s+-At\s+['"]?03:00/i);
  });
});
