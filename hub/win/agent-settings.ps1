# Shared, side-effect-free helpers for the ExpedAgent settings contract.

$script:ExpedUtf8NoBom = New-Object System.Text.UTF8Encoding $false
$script:ExpedIsWindowsPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

function Test-ExpedUserSid($Sid) {
    return ("$Sid" -match '^S-\d-(?:\d+-)+\d+$')
}

function Assert-ExpedInteractiveUserSid($Sid, $SettingsPath = '') {
    if (-not (Test-ExpedUserSid $Sid)) {
        throw 'SID do agente invalido.'
    }

    $escapedSid = "$Sid".Replace("'", "''")
    $accounts = @(
        Get-CimInstance -ClassName Win32_UserAccount -Filter "SID='$escapedSid'" -ErrorAction Stop
    )
    if ($accounts.Count -ne 1 -or [int]$accounts[0].SIDType -ne 1 -or $accounts[0].Disabled) {
        throw "SID nao identifica uma conta de usuario Windows habilitada: $Sid"
    }

    $profileKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$Sid"
    if (-not (Test-Path -LiteralPath $profileKey)) {
        throw "SID sem perfil Windows registrado: $Sid"
    }
    $profilePath = [Environment]::ExpandEnvironmentVariables(
        "$(Get-ItemPropertyValue -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction Stop)"
    )
    if (-not $profilePath -or -not (Test-Path -LiteralPath $profilePath -PathType Container)) {
        throw "Perfil Windows do SID nao existe no disco: $Sid"
    }

    if ($SettingsPath) {
        $localAppData = Join-Path $profilePath 'AppData\Local'
        $userShellKey = "Registry::HKEY_USERS\$Sid\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
        if (Test-Path -LiteralPath $userShellKey) {
            $userShellRegistry = $null
            try {
                $userShellRegistry = (Get-Item -LiteralPath $userShellKey -ErrorAction Stop)
                if ($null -eq $userShellRegistry) {
                    throw "User Shell Folders ausente para SID: $Sid"
                }
                $registeredLocalAppData = "$($userShellRegistry.GetValue(
                    'Local AppData',
                    '',
                    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
                ))"
                if ($registeredLocalAppData.StartsWith(
                    '%USERPROFILE%',
                    [System.StringComparison]::OrdinalIgnoreCase
                )) {
                    $registeredLocalAppData = $profilePath + $registeredLocalAppData.Substring(13)
                }
                $localAppData = [Environment]::ExpandEnvironmentVariables($registeredLocalAppData)
            } catch {
                throw "Nao foi possivel resolver Local AppData do SID: $Sid"
            } finally {
                if ($null -ne $userShellRegistry) { $userShellRegistry.Dispose() }
            }
        }
        $expectedPath = [System.IO.Path]::GetFullPath(
            (Join-Path $localAppData 'ExpedAgent\appsettings.json')
        )
        $actualPath = [System.IO.Path]::GetFullPath($SettingsPath)
        if (-not [string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "settingsPath nao pertence ao perfil do SID. Atual=$actualPath Esperado=$expectedPath"
        }
    }
    return $profilePath
}

function Get-ExpedFileOwnerSid($Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Arquivo para resolver owner SID nao encontrado: $Path"
    }
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    $sid = if ($owner) { "$($owner.Value)" } else { '' }
    if (-not (Test-ExpedUserSid $sid)) {
        throw "Owner do arquivo nao pode ser convertido em SID: $Path"
    }
    return $sid
}

function Get-ExpedAgentSyncNowPort($Config) {
    $value = 5005
    if ($Config.agent -and $null -ne $Config.agent.syncNowPort) {
        $value = $Config.agent.syncNowPort
    }
    $isInteger =
        $value -is [byte] -or $value -is [sbyte] -or
        $value -is [int16] -or $value -is [uint16] -or
        $value -is [int32] -or $value -is [uint32] -or
        $value -is [int64] -or $value -is [uint64]
    if (-not $isInteger -or [int64]$value -lt 0 -or [int64]$value -gt 65535) {
        throw 'agent.syncNowPort deve ser um inteiro entre 0 e 65535'
    }
    return [int]$value
}

function Get-ExpedInstalledAgentSyncNowPort($SettingsPath) {
    if (-not (Test-Path -LiteralPath $SettingsPath)) {
        throw "appsettings.json do ExpedAgent nao encontrado: $SettingsPath"
    }
    $settings = Get-Content -Raw -LiteralPath $SettingsPath | ConvertFrom-Json
    if (-not $settings.Agent) {
        throw "appsettings.json do ExpedAgent sem o no Agent: $SettingsPath"
    }
    # PowerShell resolve propriedades sem diferenciar maiusculas; projetar a
    # secao Agent reutiliza a mesma validacao estrita e o default legado 5005.
    return Get-ExpedAgentSyncNowPort ([pscustomobject]@{ agent = $settings.Agent })
}

function Write-ExpedJsonAtomically($Path, $Value) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $tempPath = "$fullPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    $replaceBackupPath = "$fullPath.$PID.$([Guid]::NewGuid().ToString('N')).bak"
    try {
        [System.IO.File]::WriteAllText($tempPath, ($Value | ConvertTo-Json -Depth 8), $script:ExpedUtf8NoBom)
        if (Test-Path -LiteralPath $fullPath) {
            if ($script:ExpedIsWindowsPlatform) {
                [System.IO.File]::Replace($tempPath, $fullPath, $replaceBackupPath)
            } else {
                [System.IO.File]::Move($tempPath, $fullPath, $true)
            }
        } else {
            [System.IO.File]::Move($tempPath, $fullPath)
        }
    } finally {
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
        if (Test-Path -LiteralPath $replaceBackupPath) { Remove-Item -LiteralPath $replaceBackupPath -Force }
    }
}

function Write-ExpedBytesAtomically($Path, [byte[]]$Bytes) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $parent = [System.IO.Path]::GetDirectoryName($fullPath)
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $tempPath = "$fullPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    $replaceBackupPath = "$fullPath.$PID.$([Guid]::NewGuid().ToString('N')).bak"
    try {
        [System.IO.File]::WriteAllBytes($tempPath, $Bytes)
        if (Test-Path -LiteralPath $fullPath) {
            if ($script:ExpedIsWindowsPlatform) {
                [System.IO.File]::Replace($tempPath, $fullPath, $replaceBackupPath)
            } else {
                [System.IO.File]::Move($tempPath, $fullPath, $true)
            }
        } else {
            [System.IO.File]::Move($tempPath, $fullPath)
        }
    } finally {
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
        if (Test-Path -LiteralPath $replaceBackupPath) { Remove-Item -LiteralPath $replaceBackupPath -Force }
    }
}

function New-ExpedFileSnapshot($Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $exists = Test-Path -LiteralPath $fullPath -PathType Leaf
    return [pscustomobject]@{
        Path = $fullPath
        Exists = $exists
        Bytes = if ($exists) { [System.IO.File]::ReadAllBytes($fullPath) } else { $null }
        AclSddl = if ($exists -and $script:ExpedIsWindowsPlatform) {
            (Get-Acl -LiteralPath $fullPath).Sddl
        } else { '' }
    }
}

function Restore-ExpedFileSnapshot($Snapshot) {
    if ($null -eq $Snapshot) { return }
    if ($Snapshot.Exists) {
        Write-ExpedBytesAtomically $Snapshot.Path $Snapshot.Bytes
        if ($script:ExpedIsWindowsPlatform -and $Snapshot.AclSddl) {
            $security = New-Object System.Security.AccessControl.FileSecurity
            $security.SetSecurityDescriptorSddlForm("$($Snapshot.AclSddl)")
            Set-Acl -LiteralPath $Snapshot.Path -AclObject $security
        }
    } elseif (Test-Path -LiteralPath $Snapshot.Path) {
        Remove-Item -LiteralPath $Snapshot.Path -Force
    }
}

function Set-ExpedAgentSettings {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$SettingsPath,
        [Parameter(Mandatory=$true)][int]$SyncNowPort,
        [string]$ApiBaseUrl = '',
        [string]$DeviceToken = '',
        [switch]$UpdateCredentials
    )

    if ($SyncNowPort -lt 0 -or $SyncNowPort -gt 65535) {
        throw 'SyncNowPort deve ser um inteiro entre 0 e 65535'
    }
    if (-not (Test-Path -LiteralPath $SettingsPath)) {
        throw "appsettings.json do ExpedAgent nao encontrado: $SettingsPath"
    }

    $settings = Get-Content -Raw -LiteralPath $SettingsPath | ConvertFrom-Json
    if (-not $settings.Agent) { throw "appsettings.json do ExpedAgent sem o no Agent: $SettingsPath" }
    $settings.Agent | Add-Member -NotePropertyName SyncNowPort -NotePropertyValue $SyncNowPort -Force
    if ($UpdateCredentials) {
        if (-not $ApiBaseUrl -or -not $DeviceToken) {
            throw 'ApiBaseUrl e DeviceToken sao obrigatorios ao atualizar credenciais do agente'
        }
        $settings.Agent.ApiBaseUrl = $ApiBaseUrl
        $settings.Agent.DeviceToken = $DeviceToken
    }
    Write-ExpedJsonAtomically $SettingsPath $settings
}
