# provision.ps1 is an internal transaction step of ExpedSetup.
# Secrets are accepted only through an ACL-protected three-line file:
#   mode (code|manual), cloud URL, provisioning code or device token.
[CmdletBinding()]
param(
  # Deprecated command-line inputs are kept only to fail with a safe migration message.
  [string]$Code,
  [string]$DeviceToken,
  [string]$CredentialsFile,
  [string]$InstallerCapabilityFile,
  [string]$CloudApi = 'https://app-exped.vercel.app',
  [string]$Root = 'C:\Exped',
  [string]$AgentDir = '',
  [string]$AgentUserSid = '',
  [switch]$DeferAgent,
  [string]$InstallerTransactionId = '',
  [switch]$RollbackTransaction,
  [switch]$FinalizeTransaction
)

$ErrorActionPreference = 'Stop'
$script:IsWindowsPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

$transactionModeCount = ([int]$RollbackTransaction.IsPresent) + ([int]$FinalizeTransaction.IsPresent)
if ($transactionModeCount -gt 1) {
  throw 'Informe apenas -RollbackTransaction ou -FinalizeTransaction.'
}
if ($Code -or $DeviceToken) {
  throw 'Segredos em -Code/-DeviceToken nao sao aceitos. Use o ExpedSetup com CredentialsFile protegido.'
}
if ($transactionModeCount -eq 0) {
  # provision.ps1 direto poderia atualizar o arquivo sem atualizar o runtime Hub/Agent.
  # Falhe antes de log, redeem ou mutacao e direcione ao fluxo que coordena ambos.
  if (-not $DeferAgent) {
    throw 'provision.ps1 direto foi desativado para evitar divergencia Hub/Agent. Rode o ExpedSetup pelo fluxo do instalador.'
  }
  if ($AgentDir -or $AgentUserSid) {
    throw '-AgentDir/-AgentUserSid nao pertencem ao fluxo transacional. Rode o ExpedSetup.'
  }
  if (-not $CredentialsFile) {
    throw 'O fluxo do instalador exige -CredentialsFile protegido.'
  }
  if (-not $InstallerCapabilityFile) {
    throw 'Capability efemera do ExpedSetup ausente. Execute o fluxo completo do instalador.'
  }
}
if ($InstallerTransactionId -notmatch '^[A-Za-z0-9_-]{16,80}$') {
  throw 'InstallerTransactionId invalido.'
}
. (Join-Path $PSScriptRoot 'agent-settings.ps1')

$logDir = Join-Path $Root 'logs'
$transactionsRoot = Join-Path (Join-Path $Root 'data') 'installer-transactions'
$journalDir = Join-Path $transactionsRoot 'provision-current'
$historyDir = Join-Path $transactionsRoot 'provision-history'
$capabilitiesDir = Join-Path $transactionsRoot 'provision-capabilities'
$capabilityRecordPath = Join-Path $capabilitiesDir "$InstallerTransactionId.json"
$statePath = Join-Path $journalDir 'state.json'
$recoveryPath = Join-Path $journalDir 'recovery-credentials.json'
$configBackupPath = Join-Path $journalDir 'config.backup'
$lockPath = Join-Path $transactionsRoot '.provision.lock'
$configPath = Join-Path $Root 'config.json'
$credentialsPathToDelete = ''
$lockStream = $null

function Log($Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try { Add-Content -LiteralPath (Join-Path $logDir 'provision.log') -Value $line } catch { }
  Write-Host $line
}

function Protect-ExpedAdministratorPath($Path, [switch]$Directory) {
  if ($script:IsWindowsPlatform) {
    if ($Directory) {
      $security = New-Object System.Security.AccessControl.DirectorySecurity
      $security.SetSecurityDescriptorSddlForm(
        'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
      )
    } else {
      $security = New-Object System.Security.AccessControl.FileSecurity
      $security.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)')
    }
    Set-Acl -LiteralPath $Path -AclObject $security
    return
  }

  $mode = if ($Directory) { '700' } else { '600' }
  & chmod $mode -- $Path
  if ($LASTEXITCODE -ne 0) { throw "chmod falhou para path protegido: $Path" }
}

function Assert-ProtectedAdministratorFile($Path, $Label) {
  $item = Get-Item -LiteralPath $Path
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label nao pode ser reparse point."
  }
  if ($script:IsWindowsPlatform) {
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) {
      throw "$Label deve ter heranca de ACL desabilitada."
    }
    $allowedSids = @('S-1-5-18', 'S-1-5-32-544')
    $ownerSid = try {
      $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    } catch { '' }
    if ($allowedSids -notcontains $ownerSid) {
      throw "$Label possui owner nao autorizado."
    }
    foreach ($rule in $acl.Access) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
        continue
      }
      $ruleSid = try {
        $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      } catch { '' }
      if ($allowedSids -notcontains $ruleSid) {
        throw "$Label concede acesso a principal nao autorizado: $ruleSid"
      }
    }
    return
  }

  if (([int]$item.UnixFileMode -band 63) -ne 0) {
    throw "$Label deve usar modo 0600 no harness nao-Windows."
  }
}

function Assert-ProtectedCredentialsFile($Path) {
  Assert-ProtectedAdministratorFile $Path 'CredentialsFile'
}

function Initialize-ProvisionStorage {
  if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  }
  if (-not (Test-Path -LiteralPath $transactionsRoot)) {
    New-Item -ItemType Directory -Force -Path $transactionsRoot | Out-Null
  }
  Protect-ExpedAdministratorPath $transactionsRoot -Directory
  $script:lockStream = [System.IO.File]::Open(
    $lockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
  Protect-ExpedAdministratorPath $lockPath
}

function Read-ProvisionJournalState {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
  return Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
}

function Ensure-ProvisionHistoryDirectory {
  if (-not (Test-Path -LiteralPath $historyDir)) {
    New-Item -ItemType Directory -Force -Path $historyDir | Out-Null
  }
  Protect-ExpedAdministratorPath $historyDir -Directory
}

function Write-ProvisionJournalState($State, [string]$Phase, [string]$Note = '') {
  $State | Add-Member -NotePropertyName Phase -NotePropertyValue $Phase -Force
  $State | Add-Member -NotePropertyName UpdatedAtUtc `
    -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
  if ($Note) {
    $State | Add-Member -NotePropertyName RecoveryNote -NotePropertyValue $Note -Force
  }
  Write-ExpedJsonAtomically $statePath $State
  Protect-ExpedAdministratorPath $statePath
}

function Repair-IncompleteProvisionJournal {
  if (-not (Test-Path -LiteralPath $journalDir -PathType Container)) { return }
  if (Test-Path -LiteralPath $statePath -PathType Leaf) { return }
  if (Test-Path -LiteralPath $recoveryPath -PathType Leaf) {
    throw 'Journal sem state.json contem recovery credential; recuperacao automatica foi recusada.'
  }

  # state.json is written before any redeem or root mutation. Its absence
  # proves this directory can only be an interrupted local initialization.
  Ensure-ProvisionHistoryDirectory
  Protect-ExpedAdministratorPath $journalDir -Directory
  $archiveName = 'incomplete-{0}-{1}' -f (
    Get-Date -Format 'yyyyMMddHHmmss'
  ), ([Guid]::NewGuid().ToString('N'))
  $archivePath = Join-Path $historyDir $archiveName
  Move-Item -LiteralPath $journalDir -Destination $archivePath
  Protect-ExpedAdministratorPath $archivePath -Directory
  $record = [pscustomobject]@{
    Phase = 'IncompleteBeforePrepared'
    RemoteCallStarted = $false
    ArchiveName = $archiveName
    ArchivedAtUtc = [DateTime]::UtcNow.ToString('o')
  }
  $recordPath = Join-Path $historyDir 'latest-incomplete.json'
  Write-ExpedJsonAtomically $recordPath $record
  Protect-ExpedAdministratorPath $recordPath
  Log 'Journal local incompleto anterior a Prepared foi arquivado; nenhum redeem havia iniciado.'
}

function Get-SecretHash([string]$Secret) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash((New-Object System.Text.UTF8Encoding $false).GetBytes($Secret))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $sha.Dispose() }
}

function Get-BytesHash([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($Bytes)
    return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $sha.Dispose() }
}

function Test-FixedTimeHex([string]$Expected, [string]$Actual) {
  if ($Expected.Length -ne $Actual.Length -or ($Expected.Length % 2) -ne 0) { return $false }
  $difference = 0
  try {
    for ($index = 0; $index -lt $Expected.Length; $index += 2) {
      $expectedByte = [Convert]::ToByte($Expected.Substring($index, 2), 16)
      $actualByte = [Convert]::ToByte($Actual.Substring($index, 2), 16)
      $difference = $difference -bor ($expectedByte -bxor $actualByte)
    }
  } catch { return $false }
  return $difference -eq 0
}

function Remove-IssuedCapabilityRecord {
  if (Test-Path -LiteralPath $capabilityRecordPath -PathType Leaf) {
    Remove-Item -LiteralPath $capabilityRecordPath -Force
  }
}

function Convert-CapabilityExpiryToUtc($Value) {
  if ($Value -is [DateTime]) { return ([DateTime]$Value).ToUniversalTime() }
  $parsed = [DateTime]::MinValue
  $dateStyles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor `
    [System.Globalization.DateTimeStyles]::AdjustToUniversal
  if (-not [DateTime]::TryParseExact(
      "$Value", 'o', [System.Globalization.CultureInfo]::InvariantCulture,
      $dateStyles, [ref]$parsed
    )) {
    throw 'Expiracao da capability e invalida.'
  }
  return $parsed.ToUniversalTime()
}

function Consume-InstallerCapability {
  if (-not (Test-Path -LiteralPath $InstallerCapabilityFile -PathType Leaf)) {
    throw 'Capability efemera do ExpedSetup nao foi encontrada.'
  }
  if (-not (Test-Path -LiteralPath $capabilityRecordPath -PathType Leaf)) {
    throw 'Verifier one-shot da capability nao foi encontrado.'
  }

  $capabilityPath = [System.IO.Path]::GetFullPath($InstallerCapabilityFile)
  if ([System.IO.Path]::GetFileName($capabilityPath) -ne 'provision-capability.json') {
    throw 'Capability deve vir do snapshot transacional do ExpedSetup.'
  }
  Assert-ProtectedAdministratorFile $capabilityPath 'InstallerCapabilityFile'
  Assert-ProtectedAdministratorFile $capabilityRecordPath 'Capability verifier'

  $snapshotStatePath = Join-Path ([System.IO.Path]::GetDirectoryName($capabilityPath)) 'hub-state.json'
  if (-not (Test-Path -LiteralPath $snapshotStatePath -PathType Leaf)) {
    throw 'Capability nao esta vinculada a um snapshot do ExpedSetup.'
  }
  $snapshotState = Get-Content -Raw -LiteralPath $snapshotStatePath | ConvertFrom-Json
  $capability = Get-Content -Raw -LiteralPath $capabilityPath | ConvertFrom-Json
  $record = Get-Content -Raw -LiteralPath $capabilityRecordPath | ConvertFrom-Json
  $expectedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  foreach ($candidateRoot in @($snapshotState.Root, $capability.Root, $record.Root)) {
    $normalizedCandidate = [System.IO.Path]::GetFullPath("$candidateRoot").TrimEnd('\', '/')
    if (-not [string]::Equals(
      $normalizedCandidate, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw 'Root da capability diverge do Root solicitado.'
    }
  }
  if ("$($capability.Schema)" -ne 'exped-setup-provision-v1' -or
      "$($record.Schema)" -ne 'exped-setup-provision-v1') {
    throw 'Schema da capability do ExpedSetup e invalido.'
  }
  if (-not [string]::Equals(
      "$($capability.TransactionId)", $InstallerTransactionId,
      [System.StringComparison]::Ordinal
    ) -or -not [string]::Equals(
      "$($record.TransactionId)", $InstallerTransactionId,
      [System.StringComparison]::Ordinal
    )) {
    throw 'Capability pertence a outra transacao do ExpedSetup.'
  }
  $expiresAtUtc = Convert-CapabilityExpiryToUtc $capability.ExpiresAtUtc
  $recordExpiresAtUtc = Convert-CapabilityExpiryToUtc $record.ExpiresAtUtc
  if ($expiresAtUtc.Ticks -ne $recordExpiresAtUtc.Ticks) {
    throw 'Expiracao da capability diverge do verifier.'
  }

  $now = [DateTime]::UtcNow
  if ($expiresAtUtc -le $now -or $expiresAtUtc -gt $now.AddMinutes(11)) {
    throw 'Capability do ExpedSetup expirou ou possui janela invalida.'
  }

  $nonceBytes = $null
  try {
    $nonce = "$($capability.Nonce)"
    if ($nonce.Length -gt 128) { throw 'Nonce da capability e invalido.' }
    $nonceBytes = [Convert]::FromBase64String($nonce)
    if ($nonceBytes.Length -ne 32) { throw 'Nonce da capability possui tamanho invalido.' }
    $actualHash = Get-BytesHash $nonceBytes
    $expectedHash = "$($record.CapabilityHash)"
    if ($expectedHash -notmatch '^[0-9a-fA-F]{64}$' -or
        -not (Test-FixedTimeHex $expectedHash $actualHash)) {
      throw 'Capability do ExpedSetup nao corresponde ao verifier protegido.'
    }

    # Remove o verifier primeiro: mesmo se a segunda remocao falhar, o bearer
    # restante ja nao pode ser reutilizado.
    Remove-Item -LiteralPath $capabilityRecordPath -Force
    Remove-Item -LiteralPath $capabilityPath -Force
  } finally {
    if ($nonceBytes) { [Array]::Clear($nonceBytes, 0, $nonceBytes.Length) }
    if ($capability) { $capability.Nonce = '' }
  }
}

function New-ProvisionJournal($Mode, $SecretHash) {
  if (Test-Path -LiteralPath $journalDir) {
    throw 'Journal atual ja existe ao criar uma nova transacao.'
  }
  New-Item -ItemType Directory -Path $journalDir | Out-Null
  Protect-ExpedAdministratorPath $journalDir -Directory
  $configExisted = Test-Path -LiteralPath $configPath -PathType Leaf
  if ($configExisted) {
    [System.IO.File]::WriteAllBytes($configBackupPath, [System.IO.File]::ReadAllBytes($configPath))
    Protect-ExpedAdministratorPath $configBackupPath
  }
  $state = [pscustomobject]@{
    TransactionId = $InstallerTransactionId
    ConfigPath = [System.IO.Path]::GetFullPath($configPath)
    ConfigExisted = $configExisted
    Mode = $Mode
    SecretHash = $SecretHash
    RedeemIsReversible = $false
    CreatedAtUtc = [DateTime]::UtcNow.ToString('o')
  }
  Write-ProvisionJournalState $state 'Prepared'
  return $state
}

function Write-RecoveryCredentials($Cloud, $Token, $CompanyName = '') {
  $recovery = [pscustomobject]@{
    CloudApi = $Cloud
    DeviceToken = $Token
    CompanyName = $CompanyName
  }
  Write-ExpedJsonAtomically $recoveryPath $recovery
  Protect-ExpedAdministratorPath $recoveryPath
}

function Read-RecoveryCredentials {
  if (-not (Test-Path -LiteralPath $recoveryPath -PathType Leaf)) {
    throw 'Journal indica credencial resgatada, mas recovery-credentials.json esta ausente.'
  }
  $recovery = Get-Content -Raw -LiteralPath $recoveryPath | ConvertFrom-Json
  if (-not $recovery.CloudApi -or -not $recovery.DeviceToken) {
    throw 'Recovery credentials incompletas.'
  }
  return $recovery
}

function Restore-ProvisionSnapshots($State) {
  $expectedPath = [System.IO.Path]::GetFullPath($configPath)
  if (-not [string]::Equals(
    "$($State.ConfigPath)", $expectedPath, [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'ConfigPath do journal diverge do Root atual.'
  }
  if ($State.ConfigExisted) {
    if (-not (Test-Path -LiteralPath $configBackupPath -PathType Leaf)) {
      throw 'config.backup ausente no journal de provisioning.'
    }
    Write-ExpedBytesAtomically $configPath ([System.IO.File]::ReadAllBytes($configBackupPath))
  } elseif (Test-Path -LiteralPath $configPath) {
    Remove-Item -LiteralPath $configPath -Force
  }
}

function Move-UnknownRedeemToHistory($State) {
  Ensure-ProvisionHistoryDirectory
  if ($State.Phase -ne 'RedeemOutcomeUnknownAbandoned') {
    Write-ProvisionJournalState $State 'RedeemOutcomeUnknownAbandoned' `
      'O resultado do redeem era desconhecido e nao pode ser desfeito; uma credencial nova foi exigida.'
  }
  $destination = Join-Path $historyDir (
    'unknown-{0}-{1}-{2}' -f (Get-Date -Format 'yyyyMMddHHmmss'),
      $State.TransactionId, ([Guid]::NewGuid().ToString('N'))
  )
  Move-Item -LiteralPath $journalDir -Destination $destination
}

function Read-ProvisionInput {
  if (-not (Test-Path -LiteralPath $CredentialsFile -PathType Leaf)) {
    throw 'CredentialsFile nao encontrado.'
  }
  $script:credentialsPathToDelete = [System.IO.Path]::GetFullPath($CredentialsFile)
  Assert-ProtectedCredentialsFile $script:credentialsPathToDelete
  $lines = [System.IO.File]::ReadAllLines($script:credentialsPathToDelete)
  if ($lines.Count -ne 3) {
    throw 'CredentialsFile deve conter modo, URL e segredo em tres linhas.'
  }
  $mode = $lines[0].Trim().ToLowerInvariant()
  $url = $lines[1].Trim()
  $secret = $lines[2].Trim()
  if ($mode -notin @('code', 'manual') -or -not $url -or -not $secret) {
    throw 'CredentialsFile contem modo, URL ou segredo invalido.'
  }
  $uri = $null
  if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri)) {
    throw 'Cloud API deve ser uma URL absoluta.'
  }
  $isLoopbackHttp = $uri.Scheme -eq 'http' -and $uri.IsLoopback
  if ($uri.Scheme -ne 'https' -and -not $isLoopbackHttp) {
    throw 'Cloud API deve usar HTTPS (HTTP e permitido apenas em loopback).'
  }
  Remove-Item -LiteralPath $script:credentialsPathToDelete -Force
  $script:credentialsPathToDelete = ''
  return [pscustomobject]@{ Mode = $mode; CloudApi = $url.TrimEnd('/'); Secret = $secret }
}

function Invoke-ProvisionRollback {
  Remove-IssuedCapabilityRecord
  $state = Read-ProvisionJournalState
  if ($null -eq $state) { return }
  if (-not [string]::Equals(
    "$($state.TransactionId)", $InstallerTransactionId, [System.StringComparison]::Ordinal
  )) {
    throw 'InstallerTransactionId nao possui o journal atual para rollback.'
  }
  Restore-ProvisionSnapshots $state
  if (Test-Path -LiteralPath $recoveryPath -PathType Leaf) {
    Write-ProvisionJournalState $state 'RolledBackRetryable' `
      'Redeem nao pode ser desfeito; a credencial protegida sera reutilizada no retry.'
  } else {
    Write-ProvisionJournalState $state 'RedeemOutcomeUnknown' `
      'RedeemStarted terminou com resultado desconhecido; o codigo pode ter sido consumido.'
  }
}

function Invoke-ProvisionFinalize {
  Remove-IssuedCapabilityRecord
  $state = Read-ProvisionJournalState
  if ($null -eq $state) { return }
  if (-not [string]::Equals(
    "$($state.TransactionId)", $InstallerTransactionId, [System.StringComparison]::Ordinal
  )) {
    throw 'InstallerTransactionId nao possui o journal atual para finalize.'
  }
  if ($state.Phase -ne 'ConfigsWritten') {
    throw "Journal nao pode finalizar na fase $($state.Phase)."
  }
  Ensure-ProvisionHistoryDirectory
  $history = [pscustomobject]@{
    Phase = 'Completed'
    TransactionId = $InstallerTransactionId
    Mode = "$($state.Mode)"
    RedeemIsReversible = $false
    CompletedAtUtc = [DateTime]::UtcNow.ToString('o')
  }
  $latestPath = Join-Path $historyDir 'latest.json'
  Write-ExpedJsonAtomically $latestPath $history
  Protect-ExpedAdministratorPath $latestPath
  Remove-Item -LiteralPath $journalDir -Recurse -Force
}

Initialize-ProvisionStorage
try {
  Repair-IncompleteProvisionJournal
  if ($RollbackTransaction) {
    Invoke-ProvisionRollback
    exit 0
  }
  if ($FinalizeTransaction) {
    Invoke-ProvisionFinalize
    exit 0
  }

  Consume-InstallerCapability
  $input = Read-ProvisionInput
  $incomingHash = Get-SecretHash $input.Secret
  $state = Read-ProvisionJournalState
  if ($state -and $state.Phase -eq 'RedeemOutcomeUnknownAbandoned') {
    Move-UnknownRedeemToHistory $state
    $state = $null
  }
  if ($state -and $state.Phase -in @('RedeemStarted', 'RedeemOutcomeUnknown')) {
    if ($input.Mode -eq 'code' -and "$($state.SecretHash)" -eq $incomingHash) {
      throw 'RedeemStarted ficou com resultado desconhecido; o codigo pode ter sido consumido. Gere um novo codigo para retry seguro.'
    }
    Move-UnknownRedeemToHistory $state
    $state = $null
  }
  if ($null -eq $state) {
    $state = New-ProvisionJournal $input.Mode $incomingHash
  } elseif ($state.Phase -eq 'Prepared') {
    $state | Add-Member -NotePropertyName TransactionId `
      -NotePropertyValue $InstallerTransactionId -Force
    $state | Add-Member -NotePropertyName Mode -NotePropertyValue $input.Mode -Force
    $state | Add-Member -NotePropertyName SecretHash -NotePropertyValue $incomingHash -Force
    Write-ProvisionJournalState $state 'Prepared' `
      'Tentativa local retomada antes de qualquer chamada remota.'
  } else {
    $state | Add-Member -NotePropertyName TransactionId `
      -NotePropertyValue $InstallerTransactionId -Force
  }

  $recovery = $null
  if ($state.Phase -in @('Redeemed', 'ConfigsWritten', 'RolledBackRetryable')) {
    $recovery = Read-RecoveryCredentials
    Write-ProvisionJournalState $state 'Redeemed' `
      'Redeem nao e reversivel; retry reutiliza a credencial ja persistida sob ACL.'
    Log 'Retomando credencial protegida de uma tentativa anterior; nenhum novo redeem foi feito.'
  } elseif ($input.Mode -eq 'manual') {
    Write-RecoveryCredentials $input.CloudApi $input.Secret
    Write-ProvisionJournalState $state 'Redeemed' `
      'Credencial manual persistida sob ACL para recuperacao transacional.'
    $recovery = Read-RecoveryCredentials
  } else {
    Write-ProvisionJournalState $state 'RedeemStarted' `
      'A chamada remota iniciou; ate Redeemed o resultado e desconhecido e o codigo pode ter sido consumido.'
    Log "Resgatando codigo em $($input.CloudApi)/api/provision/redeem ..."
    $body = @{ code = $input.Secret } | ConvertTo-Json -Compress
    $response = Invoke-RestMethod -Method Post `
      -Uri "$($input.CloudApi)/api/provision/redeem" `
      -ContentType 'application/json' -Body $body -TimeoutSec 30
    if (-not $response.deviceToken -or -not $response.cloudApiUrl) {
      throw 'Redeem retornou resposta incompleta.'
    }
    Write-RecoveryCredentials $response.cloudApiUrl $response.deviceToken "$($response.empresaNome)"
    Write-ProvisionJournalState $state 'Redeemed' `
      'Redeem concluido e nao pode ser desfeito; token protegido esta pronto para retry.'
    $recovery = Read-RecoveryCredentials
  }

  $config = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  } else { [pscustomobject]@{} }
  if (-not $config.agent) {
    $config | Add-Member -NotePropertyName agent `
      -NotePropertyValue ([pscustomobject]@{ syncNowPort = 5005 }) -Force
  } elseif ($null -eq $config.agent.syncNowPort) {
    $config.agent | Add-Member -NotePropertyName syncNowPort -NotePropertyValue 5005 -Force
  }
  $null = Get-ExpedAgentSyncNowPort $config
  $config | Add-Member -NotePropertyName cloud -NotePropertyValue ([pscustomobject]@{
    apiBase = "$($recovery.CloudApi)"
    deviceToken = "$($recovery.DeviceToken)"
  }) -Force
  Write-ExpedJsonAtomically $configPath $config
  Write-ProvisionJournalState $state 'ConfigsWritten'
  Log 'config.json foi atualizado atomicamente; Agent permanece deferido ao usuario original.'
  exit 0
} catch {
  $phase = try { (Read-ProvisionJournalState).Phase } catch { 'Unknown' }
  Log "ERRO de provisioning na fase $phase; nenhum segredo foi registrado."
  if ($phase -in @('Redeemed', 'ConfigsWritten') -and (Test-Path -LiteralPath $recoveryPath)) {
    try {
      $state = Read-ProvisionJournalState
      Restore-ProvisionSnapshots $state
      Write-ProvisionJournalState $state 'RolledBackRetryable' `
        'Redeem nao pode ser desfeito; o retry reutilizara a credencial protegida.'
    } catch { Log 'ERRO: rollback local falhou; journal foi preservado para recuperacao.' }
  }
  Write-Error 'Provisioning falhou; o journal persistente foi preservado para retry seguro.'
  exit 1
} finally {
  if ($credentialsPathToDelete -and (Test-Path -LiteralPath $credentialsPathToDelete)) {
    try { Remove-Item -LiteralPath $credentialsPathToDelete -Force }
    catch { Log 'AVISO: arquivo efemero de credenciais nao pode ser apagado.' }
  }
  if ($lockStream) { $lockStream.Dispose() }
}
