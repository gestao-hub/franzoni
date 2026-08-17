<#
.SYNOPSIS
    Para e remove o serviço Windows ExpedHub e remove a regra de firewall.
    Por padrao PRESERVA os dados (C:\Exped\data); use -RemoveData para apagar.

.DESCRIPTION
    - Para o serviço ExpedHub (se rodando) e o remove via NSSM.
    - Remove a regra de firewall "ExpedHub".
    - NAO apaga C:\Exped\data por padrao (banco + storage do cliente).
      Passe -RemoveData $true SOMENTE se quiser zerar tudo.

.NOTES
    Rodar como Administrador. Chamado pelo evento de uninstall do Inno Setup.
#>

[CmdletBinding()]
param(
    [string]$Root        = 'C:\Exped',
    [string]$ServiceName = 'ExpedHub',
    [string]$ConfigPath  = '',
    [bool]  $RemoveData  = $false,
    [ValidateSet('true', 'false')]
    [string]$ManageAgent = 'false'
)

$ErrorActionPreference = 'Stop'
$ManageAgentEnabled = $ManageAgent -eq 'true'
$Nssm    = Join-Path $Root 'bin\nssm.exe'
$DataDir = Join-Path $Root 'data'
$AgentUserHelper = Join-Path $Root 'hub\win\agent-user-install.ps1'
$AgentSettingsHelper = Join-Path $Root 'hub\win\agent-settings.ps1'
if (-not $ConfigPath) { $ConfigPath = Join-Path $Root 'config.json' }
if ($ManageAgentEnabled) {
    if (-not (Test-Path -LiteralPath $AgentSettingsHelper)) {
        Write-Error "Helper do agente ausente: $AgentSettingsHelper"
        exit 2
    }
    . $AgentSettingsHelper
}
function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Test-AgentSid($Sid) {
    return ("$Sid" -match '^S-\d-(?:\d+-)+\d+$')
}

function Invoke-NativeQuery($FilePath, $Arguments) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousEap }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = ($output -join "`n") }
}

function Invoke-NativeChecked($FilePath, $Arguments, $AllowedExitCodes = @(0)) {
    $result = Invoke-NativeQuery $FilePath $Arguments
    if ($AllowedExitCodes -notcontains $result.ExitCode) {
        throw "$FilePath falhou ($($result.ExitCode)): $($Arguments -join ' ') - $($result.Output)"
    }
    return $result
}

function Invoke-AgentCleanupAsOriginalUser {
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        Write-Warning 'config.json ausente; nao e possivel provar que o agente foi removido.'
        return $false
    }
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Stop'
    $taskFolder = $null
    $taskName = $null
    try {
        $cfg = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
        $settingsPath = if ($cfg.agent -and $cfg.agent.settingsPath) {
            [System.IO.Path]::GetFullPath("$($cfg.agent.settingsPath)")
        } else { $null }
        if (-not $settingsPath) {
            throw 'agent.settingsPath ausente; ownership do perfil nao pode ser provado.'
        }
        if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
            throw "agent.settingsPath nao existe como arquivo; ownership nao pode ser provado: $settingsPath"
        }
        if (-not (Test-Path -LiteralPath $AgentUserHelper)) {
            throw "Helper do usuario original ausente: $AgentUserHelper"
        }

        $userSid = if ($cfg.agent) { "$($cfg.agent.userSid)" } else { '' }
        $ownerSid = Get-ExpedFileOwnerSid $settingsPath
        if (-not (Test-AgentSid $userSid)) { $userSid = $ownerSid }
        if (-not (Test-AgentSid $userSid)) {
            throw 'agent.userSid ausente e owner SID do settingsPath indisponivel; cleanup do perfil nao executado.'
        }
        if (-not [string]::Equals(
            $ownerSid, $userSid, [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw "Owner SID do settingsPath diverge de agent.userSid. Owner=$ownerSid Config=$userSid"
        }
        $null = Assert-ExpedInteractiveUserSid $userSid $settingsPath

        $interactiveSids = @(
            Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" |
                ForEach-Object {
                    try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid } catch { $null }
                } |
                Where-Object { $_ } |
                Sort-Object -Unique
        )
        if ($interactiveSids -notcontains $userSid) {
            throw "O usuario original $userSid nao tem sessao Explorer ativa. Entre nesse usuario e desinstale novamente."
        }

        $receiptId = "uninstall-$([Guid]::NewGuid().ToString('N'))"
        $taskName = "ExpedAgent-Cleanup-$([Guid]::NewGuid().ToString('N'))"
        $powershellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Uninstall -Root "{1}" -ReceiptId "{2}" -ExpectedUserSid "{3}" -ExpectedSettingsPath "{4}"' -f `
            $AgentUserHelper, $Root, $receiptId, $userSid, $settingsPath

        # Inno nao suporta runasoriginaluser durante uninstall. A tarefa one-shot
        # usa o equivalente do Windows: TASK_LOGON_INTERACTIVE_TOKEN para o SID exato.
        $TASK_ACTION_EXEC = 0
        $TASK_CREATE_OR_UPDATE = 6
        $TASK_LOGON_INTERACTIVE_TOKEN = 3
        $TASK_RUNLEVEL_LUA = 0
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $taskFolder = $scheduler.GetFolder('\')
        $definition = $scheduler.NewTask(0)
        $definition.RegistrationInfo.Description = 'ExpedAgent cleanup no usuario original'
        $definition.Principal.UserId = $userSid
        $definition.Principal.LogonType = $TASK_LOGON_INTERACTIVE_TOKEN
        $definition.Principal.RunLevel = $TASK_RUNLEVEL_LUA
        $definition.Settings.Enabled = $true
        $definition.Settings.Hidden = $true
        $definition.Settings.AllowDemandStart = $true
        $definition.Settings.DisallowStartIfOnBatteries = $false
        $definition.Settings.StopIfGoingOnBatteries = $false
        $definition.Settings.ExecutionTimeLimit = 'PT2M'
        $action = $definition.Actions.Create($TASK_ACTION_EXEC)
        $action.Path = $powershellExe
        $action.Arguments = $arguments
        $registeredTask = $taskFolder.RegisterTaskDefinition(
            $taskName, $definition, $TASK_CREATE_OR_UPDATE,
            $userSid, $null, $TASK_LOGON_INTERACTIVE_TOKEN, $null)
        $null = $registeredTask.Run($null)

        $users = [Microsoft.Win32.Registry]::Users
        $receiptPath = "$userSid\Software\Exped\UninstallReceipts\$receiptId"
        $deadline = (Get-Date).AddSeconds(45)
        $receipt = $null
        do {
            Start-Sleep -Milliseconds 250
            $key = $users.OpenSubKey($receiptPath, $true)
            if ($null -ne $key) {
                try {
                    $receipt = [pscustomobject]@{
                        UserSid = "$($key.GetValue('UserSid', ''))"
                        Status = "$($key.GetValue('Status', ''))"
                        Message = "$($key.GetValue('Message', ''))"
                    }
                } finally { $key.Close() }
                break
            }
        } while ((Get-Date) -lt $deadline)

        if ($null -eq $receipt) { throw 'Timeout aguardando recibo do cleanup no usuario original.' }
        if ($receipt.UserSid -ne $userSid -or $receipt.Status -ne 'Complete') {
            throw "Cleanup do agente falhou no usuario original: $($receipt.Message)"
        }
        $users.DeleteSubKeyTree($receiptPath, $false)
        Write-Step "Agente e Startup removidos no SID original $userSid"
        return $true
    } catch {
        Write-Warning "Cleanup do agente no usuario original nao concluido: $($_.Exception.Message)"
        return $false
    } finally {
        if ($taskFolder -and $taskName) {
            try { $taskFolder.DeleteTask($taskName, 0) } catch { }
        }
        $ErrorActionPreference = $previousEap
    }
}

function Get-UrlAclSddlFromOutput($Output) {
    foreach ($line in ("$Output" -split "`r?`n")) {
        $index = $line.IndexOf('D:(', [System.StringComparison]::OrdinalIgnoreCase)
        if ($index -ge 0) { return $line.Substring($index).Trim() }
    }
    return $null
}

function Remove-AgentUrlAcl {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return }
    try { $cfg = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json }
    catch {
        Write-Warning "URL ACL do agente nao verificada: config invalido em $ConfigPath"
        return
    }

    $port = if ($cfg.agent -and $null -ne $cfg.agent.urlAclPort) { [int]$cfg.agent.urlAclPort } else { 0 }
    $sid = if ($cfg.agent) { "$($cfg.agent.urlAclUserSid)" } else { '' }
    if ($port -le 0) { return }
    if ($port -gt 65535 -or $sid -notmatch '^S-\d-(?:\d+-)+\d+$') {
        Write-Warning 'URL ACL do agente nao removida: rastreamento de porta/SID invalido.'
        return
    }

    $url = "http://127.0.0.1:$port/"
    $expectedSddl = "D:(A;;GX;;;$sid)"
    $query = Invoke-NativeChecked 'netsh.exe' `
        @('http', 'show', 'urlacl', "url=$url") @(0, 1)
    $actualSddl = Get-UrlAclSddlFromOutput $query.Output
    if (-not $actualSddl) { return }
    if (-not [string]::Equals($actualSddl, $expectedSddl, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Warning "URL ACL $url nao removida: SDDL atual nao pertence ao Exped. Atual=$actualSddl Esperado=$expectedSddl"
        return
    }

    Write-Step "Removendo URL ACL do agente em $url"
    $null = Invoke-NativeChecked 'netsh.exe' @('http', 'delete', 'urlacl', "url=$url")
}

# ---------------------------------------------------------------------------
# 1. Parar + remover o serviço
# ---------------------------------------------------------------------------
$agentCleanupComplete = $true
if ($ManageAgentEnabled) {
    $agentCleanupComplete = Invoke-AgentCleanupAsOriginalUser
}
if (-not $agentCleanupComplete) {
    Write-Error 'DESINSTALACAO ABORTADA: agente/Startup nao foram removidos. Servico, URL ACL, firewall e arquivos foram preservados.'
    exit 2
}

try {
    if (Test-Path $Nssm) {
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($service) {
            if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
                Write-Step "Parando servico $ServiceName"
                $null = Invoke-NativeChecked $Nssm @('stop', $ServiceName)
                Start-Sleep -Seconds 2
            }
            Write-Step "Removendo servico $ServiceName"
            $null = Invoke-NativeChecked $Nssm @('remove', $ServiceName, 'confirm')
        } else {
            Write-Host "    Servico $ServiceName nao registrado - nada a remover."
        }
    } else {
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($service) {
            Write-Step "nssm.exe ausente - removendo via ServiceController/sc.exe"
            if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
                Stop-Service -Name $ServiceName -Force -ErrorAction Stop
                (Get-Service -Name $ServiceName).WaitForStatus(
                    [System.ServiceProcess.ServiceControllerStatus]::Stopped,
                    [TimeSpan]::FromSeconds(30)
                )
            }
            $null = Invoke-NativeChecked 'sc.exe' @('delete', $ServiceName)
        }
    }

    # O pacote hub-only nunca toca URL ACL ou perfil do agente.
    if ($ManageAgentEnabled) { Remove-AgentUrlAcl }
    Write-Step "Removendo regra de firewall ExpedHub"
    $null = Invoke-NativeChecked 'netsh.exe' @(
        'advfirewall', 'firewall', 'delete', 'rule', 'name=ExpedHub'
    )

    if ($RemoveData) {
        Write-Step "RemoveData=true - apagando $DataDir"
        if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }
    } else {
        Write-Host "==> Dados PRESERVADOS em $DataDir (use -RemoveData `$true para apagar)." -ForegroundColor Yellow
    }
    Write-Step "Concluido."
} catch {
    Write-Error "DESINSTALACAO ABORTADA por falha nativa: $($_.Exception.Message)"
    exit 3
}
