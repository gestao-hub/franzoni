# Native Windows canary for the Exped Hub and interactive ExpedAgent.
# The 03:00 schedule remains PAUSADO until this canary is completed on real hardware.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('InstallHooks', 'PreLogin', 'PostLogin', 'SyncButton', 'Rollback', 'Report', 'Cleanup')]
    [string]$Mode,
    [string]$Root = 'C:\Exped',
    [string]$RollbackManifestUrl = '',
    [switch]$ConfirmRollback
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$receiptDir = Join-Path $env:ProgramData 'Exped\windows-canary'
$preLoginTask = 'Exped-Canary-PreLogin'
$postLoginTask = 'Exped-Canary-PostLogin'
$incidentContext = [ordered]@{
    HiperUpgrade = 'Hiper Loja 195 foi atualizado para Hiper Loja 197 na sexta anterior.'
    Evidence = 'O pedido local existia; o bloqueio observado era do sync cloud.'
    Attribution = 'Nao atribuir o incidente a versao 197 sem evidencia causal.'
    DiagnosticBoundary = 'Agent em execucao e consulta ao Hiper funcionando sao sinais distintos.'
}

function Get-CanaryConfig {
    $configPath = Join-Path $Root 'config.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "config.json ausente: $configPath"
    }
    return Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
}

function Get-CanaryStatusUrl($Config) {
    $appPort = if ($Config.ports -and $Config.ports.app) { [int]$Config.ports.app } else { 3000 }
    $statusPort = if ($Config.ports -and $Config.ports.status) {
        [int]$Config.ports.status
    } else { $appPort + 1 }
    return "http://127.0.0.1:$statusPort/status"
}

function Get-CanaryStatus([int]$TimeoutSeconds = 180) {
    $statusUrl = Get-CanaryStatusUrl (Get-CanaryConfig)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastFailure = 'sem resposta'
    do {
        try {
            $response = Invoke-WebRequest -Uri $statusUrl -UseBasicParsing -TimeoutSec 5
            return $response.Content | ConvertFrom-Json
        } catch {
            $lastFailure = $_.Exception.Message
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    throw "Timeout consultando /status em $statusUrl. Ultimo erro: $lastFailure"
}

function Assert-HubAndSync($Status) {
    if ($Status.storage.running -ne $true) { throw 'storage nao esta running.' }
    foreach ($name in @('postgres', 'postgrest', 'gotrue', 'gateway', 'app', 'events', 'frontdoor')) {
        $matches = @($Status.peers | Where-Object { $_.name -eq $name -and $_.running -eq $true })
        if ($matches.Count -ne 1) { throw "peer essencial nao esta running: $name" }
    }
    if ($Status.agent.startupMode -ne 'interactive_logon') {
        throw 'startupMode deve permanecer interactive_logon.'
    }
    if ($Status.agent.survivesRebootWithoutLogon -ne $false) {
        throw 'survivesRebootWithoutLogon afirmou garantia inexistente.'
    }
    if ($Status.sync.enabled -ne $true) { throw 'sync cloud nao esta enabled.' }
    if (-not ($Status.sync.PSObject.Properties.Name -contains 'lastError')) {
        throw 'sync.lastError esta ausente.'
    }
    if ($null -ne $Status.sync.lastError) {
        throw "sync cloud reportou lastError: $($Status.sync.lastError)"
    }
}

function Assert-PostLoginReadiness($Status) {
    Assert-HubAndSync $Status
    if ($Status.agent.running -ne $true) {
        throw 'Agent nao esta em execucao apos logon da conta operacional.'
    }
    if ($Status.agent.hiper.connected -ne $true) {
        throw 'Agent esta em execucao, mas a conectividade Hiper falhou.'
    }
    if ($Status.agent.hiper.queryOk -ne $true) {
        throw 'Agent esta em execucao, mas a consulta read-only Hiper falhou.'
    }
    if ($Status.agent.hiper.schemaCompatible -ne $true -or
        $Status.agent.hiper.targetSchema -ne 'Hiper Loja 197') {
        throw 'O probe nao comprovou compatibilidade com Hiper Loja 197.'
    }
}

function Get-CanaryOperationalSid($Config) {
    $sid = "$($Config.agent.userSid)"
    if ($sid -notmatch '^S-\d-(?:\d+-)+\d+$') {
        throw 'config.agent.userSid ausente ou invalido.'
    }
    return $sid
}

function Initialize-CanaryDirectory($OperationalSid) {
    New-Item -ItemType Directory -Force -Path $receiptDir | Out-Null
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'
    $adminSid = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'
    $userSid = New-Object System.Security.Principal.SecurityIdentifier $OperationalSid
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $none = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetOwner($adminSid)
    $security.SetAccessRuleProtection($true, $false)
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow
    )))
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $adminSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow
    )))
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $userSid, [System.Security.AccessControl.FileSystemRights]::Modify, $inherit, $none, $allow
    )))
    Set-Acl -LiteralPath $receiptDir -AclObject $security
}

function Write-CanaryReceipt($Phase, $Status, $Details) {
    if (-not (Test-Path -LiteralPath $receiptDir -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $receiptDir | Out-Null
    }
    $record = [ordered]@{
        schema = 'exped-windows-canary-v1'
        phase = $Phase
        checkedAtUtc = [DateTime]::UtcNow.ToString('o')
        computer = $env:COMPUTERNAME
        windowsIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        incidentContext = $incidentContext
        agentProcessRunning = if ($Status) { $Status.agent.running -eq $true } else { $null }
        hiperReadOnlyQueryWorking = if ($Status) { $Status.agent.hiper.queryOk -eq $true } else { $null }
        status = $Status
        details = $Details
    }
    $name = '{0}-{1}-{2}.json' -f ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')), $Phase, ([Guid]::NewGuid().ToString('N'))
    $path = Join-Path $receiptDir $name
    $temp = "$path.tmp"
    try {
        [System.IO.File]::WriteAllText($temp, ($record | ConvertTo-Json -Depth 16), $utf8NoBom)
        [System.IO.File]::Move($temp, $path)
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    }
    Write-Host "Canary receipt: $path"
}

function Install-CanaryHooks {
    $config = Get-CanaryConfig
    $sid = Get-CanaryOperationalSid $config
    Initialize-CanaryDirectory $sid
    $scriptPath = Join-Path $Root 'hub\win\windows-canary.ps1'
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "Canary ausente: $scriptPath" }
    $powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew

    $preArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode PreLogin -Root "{1}"' -f $scriptPath, $Root
    $preAction = New-ScheduledTaskAction -Execute $powerShell -Argument $preArgs
    $preTrigger = New-ScheduledTaskTrigger -AtStartup
    $prePrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $preTask = New-ScheduledTask -Action $preAction -Trigger $preTrigger -Principal $prePrincipal -Settings $settings
    Register-ScheduledTask -TaskName $preLoginTask -InputObject $preTask -Force | Out-Null

    $account = (New-Object System.Security.Principal.SecurityIdentifier $sid).Translate(
        [System.Security.Principal.NTAccount]
    ).Value
    $postArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode PostLogin -Root "{1}"' -f $scriptPath, $Root
    $postAction = New-ScheduledTaskAction -Execute $powerShell -Argument $postArgs
    $postTrigger = New-ScheduledTaskTrigger -AtLogOn -User $account
    $postPrincipal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    $postTask = New-ScheduledTask -Action $postAction -Trigger $postTrigger -Principal $postPrincipal -Settings $settings
    Register-ScheduledTask -TaskName $postLoginTask -InputObject $postTask -Force | Out-Null

    Write-CanaryReceipt 'InstallHooks' $null ([ordered]@{
        operationalSid = $sid
        operationalAccount = $account
        preLogin = 'AtStartup SYSTEM diagnostica somente o Hub; nunca inicia o Agent.'
        postLogin = 'AtLogOn usa o token interativo da conta operacional, sem senha e sem S4U.'
        recovery = 'interactive_logon; windows_service e pre-login Agent nao sao garantidos.'
        schedule03 = '03:00 PAUSADO ate aprovacao do canario nativo.'
    })
}

function Invoke-PreLoginCanary {
    $status = Get-CanaryStatus 240
    Assert-HubAndSync $status
    if ($status.agent.running -eq $true) {
        throw 'PreLogin encontrou Agent ativo; investigue auto-logon ou mecanismo nao documentado.'
    }
    Write-CanaryReceipt 'PreLogin' $status ([ordered]@{
        result = 'Hub recuperou sem login; Agent corretamente nao foi declarado recuperado.'
        next = 'Efetue logon na conta operacional e confira o receipt PostLogin.'
    })
}

function Invoke-PostLoginCanary {
    $deadline = (Get-Date).AddMinutes(5)
    $lastFailure = 'sem status'
    do {
        try {
            $status = Get-CanaryStatus 30
            Assert-PostLoginReadiness $status
            Write-CanaryReceipt 'PostLogin' $status ([ordered]@{
                agent = 'Agent em execucao comprovado por heartbeat fresco.'
                hiper = 'Consulta read-only real e schema Hiper Loja 197 comprovados separadamente.'
            })
            return
        } catch {
            $lastFailure = $_.Exception.Message
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw "PostLogin nao ficou pronto: $lastFailure"
}

function Test-NewerTimestamp($After, $Before) {
    if (-not $After) { return $false }
    if (-not $Before) { return $true }
    return [DateTime]::Parse("$After").ToUniversalTime() -gt [DateTime]::Parse("$Before").ToUniversalTime()
}

function Invoke-SyncButtonCanary {
    $before = Get-CanaryStatus 60
    Assert-PostLoginReadiness $before
    Start-Process 'https://localhost/plataforma'
    $confirmation = Read-Host 'Clique no controle Sincronizar na interface, aguarde a confirmacao visual e digite OK'
    if ($confirmation -ne 'OK') { throw 'Evidencia do controle Sincronizar nao confirmada pelo tecnico.' }

    $deadline = (Get-Date).AddMinutes(3)
    do {
        $after = Get-CanaryStatus 30
        Assert-PostLoginReadiness $after
        $agentAdvanced = Test-NewerTimestamp $after.agent.checkedAt $before.agent.checkedAt
        $syncAdvanced = Test-NewerTimestamp $after.sync.lastSyncAt $before.sync.lastSyncAt
        if ($agentAdvanced -and $syncAdvanced) {
            Write-CanaryReceipt 'SyncButton' $after ([ordered]@{
                operatorConfirmation = $confirmation
                beforeAgentCheckedAt = $before.agent.checkedAt
                afterAgentCheckedAt = $after.agent.checkedAt
                beforeCloudSyncAt = $before.sync.lastSyncAt
                afterCloudSyncAt = $after.sync.lastSyncAt
                interpretation = 'Evidencia temporal do botao, probe Hiper e sync; nao prova causalidade da versao 197.'
            })
            return
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw 'Sincronizar nao produziu heartbeat do Agent e sync cloud posteriores dentro do prazo.'
}

function Invoke-RollbackCanary {
    # rollback is destructive and requires an explicit, purpose-built manifest.
    if (-not $ConfirmRollback) { throw 'Rollback exige -ConfirmRollback.' }
    $uri = $null
    if (-not [Uri]::TryCreate($RollbackManifestUrl, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https') {
        throw 'RollbackManifestUrl deve ser uma URL HTTPS absoluta de canario.'
    }
    $config = Get-CanaryConfig
    $config | Add-Member -NotePropertyName manifestUrl -NotePropertyValue $RollbackManifestUrl -Force
    $tempConfig = Join-Path $receiptDir ("rollback-config-{0}.json" -f ([Guid]::NewGuid().ToString('N')))
    $pointerPath = Join-Path $Root 'releases\current'
    $beforePointer = if (Test-Path -LiteralPath $pointerPath) {
        Get-Content -Raw -LiteralPath $pointerPath
    } else { '' }
    try {
        [System.IO.File]::WriteAllText($tempConfig, ($config | ConvertTo-Json -Depth 16), $utf8NoBom)
        $node = Join-Path $Root 'bin\node.exe'
        $forceUpdate = Join-Path $Root 'hub\force-update.mjs'
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = @(& $node $forceUpdate $tempConfig 2>&1 | ForEach-Object { "$_" })
            $exitCode = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousEap }
        $resultLine = @($output | Where-Object { $_ -match '^RESULTADO:\s*\{' }) | Select-Object -Last 1
        if (-not $resultLine) { throw "force-update sem resultado de rollback. Exit=$exitCode" }
        $result = ($resultLine -replace '^RESULTADO:\s*', '') | ConvertFrom-Json
        if ($result.rolledBack -ne $true -or $result.updated -eq $true) {
            throw "Manifesto nao exercitou rollback comprovado: $resultLine"
        }
        $afterPointer = if (Test-Path -LiteralPath $pointerPath) {
            Get-Content -Raw -LiteralPath $pointerPath
        } else { '' }
        if ($afterPointer -ne $beforePointer) { throw 'Pointer nao voltou ao release anterior.' }
        $status = Get-CanaryStatus 180
        Assert-PostLoginReadiness $status
        Write-CanaryReceipt 'Rollback' $status ([ordered]@{
            manifestUrl = $RollbackManifestUrl
            forceUpdateExitCode = $exitCode
            result = $result
            pointerRestored = $true
        })
    } finally {
        if (Test-Path -LiteralPath $tempConfig) { Remove-Item -LiteralPath $tempConfig -Force }
    }
}

function Show-CanaryReport {
    Write-Output ($incidentContext | ConvertTo-Json -Depth 4)
    if (-not (Test-Path -LiteralPath $receiptDir -PathType Container)) {
        throw "Nenhum receipt encontrado em $receiptDir"
    }
    Get-ChildItem -LiteralPath $receiptDir -Filter '*.json' -File |
        Sort-Object LastWriteTimeUtc |
        ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName }
}

function Remove-CanaryHooks {
    foreach ($taskName in @($preLoginTask, $postLoginTask)) {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
    }
    Write-Host 'Canary hooks removidos; receipts foram preservados.'
}

switch ($Mode) {
    'InstallHooks' { Install-CanaryHooks; break }
    'PreLogin' { Invoke-PreLoginCanary; break }
    'PostLogin' { Invoke-PostLoginCanary; break }
    'SyncButton' { Invoke-SyncButtonCanary; break }
    'Rollback' { Invoke-RollbackCanary; break }
    'Report' { Show-CanaryReport; break }
    'Cleanup' { Remove-CanaryHooks; break }
}
