# ClosedMesh installer — Windows x86_64.
#
#   iwr -useb https://closedmesh.com/install.ps1 | iex
#   iwr -useb https://closedmesh.com/install.ps1 | iex; closedmesh-install -Service
#
# Detects whether your GPU prefers the CUDA or Vulkan flavor, downloads the
# matching closedmesh-windows-x86_64-<flavor>.zip, installs closedmesh.exe to
# %LOCALAPPDATA%\closedmesh\bin, and (with -Service) registers a Scheduled
# Task so it auto-starts at login.
#
# Backend override:
#   $env:CLOSEDMESH_BACKEND = 'cuda' | 'vulkan' | 'cpu'
#   iwr -useb https://closedmesh.com/install.ps1 | iex; closedmesh-install
#
# Uninstall:
#   schtasks /Delete /TN ClosedMesh /F
#   Remove-Item -Recurse $env:LOCALAPPDATA\closedmesh

[CmdletBinding()]
param(
    [switch]$Service,
    [switch]$NoStartService,
    [string]$InstallDir,
    [string]$Repo,
    [string]$Backend
)

$ErrorActionPreference = 'Stop'

if (-not $Repo)        { $Repo        = if ($env:CLOSEDMESH_INSTALL_REPO) { $env:CLOSEDMESH_INSTALL_REPO } else { 'closedmesh/closedmesh-llm' } }
if (-not $InstallDir)  { $InstallDir  = if ($env:CLOSEDMESH_INSTALL_DIR)  { $env:CLOSEDMESH_INSTALL_DIR }  else { Join-Path $env:LOCALAPPDATA 'closedmesh\bin' } }
if (-not $Backend)     { $Backend     = $env:CLOSEDMESH_BACKEND }

$TaskName = 'ClosedMesh'
$DataDir  = Join-Path $env:USERPROFILE '.closedmesh'
$LogDir   = Join-Path $env:LOCALAPPDATA 'closedmesh\logs'

function Write-Info  { param($Msg) Write-Host "[closedmesh] $Msg" -ForegroundColor Cyan }
function Write-Ok    { param($Msg) Write-Host "[closedmesh] $Msg" -ForegroundColor Green }
function Write-Warn2 { param($Msg) Write-Host "[closedmesh] $Msg" -ForegroundColor Yellow }
function Write-Err   { param($Msg) Write-Host "[closedmesh] $Msg" -ForegroundColor Red }

function Detect-Backend {
    if ($Backend) { return $Backend.ToLower() }

    # NVIDIA: prefer nvidia-smi if available, else inspect the device list.
    $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($nvidiaSmi) {
        try {
            $null = & nvidia-smi -L 2>$null
            if ($LASTEXITCODE -eq 0) { return 'cuda' }
        } catch { }
    }

    try {
        $videoControllers = Get-CimInstance Win32_VideoController -ErrorAction Stop
    } catch {
        $videoControllers = @()
    }

    foreach ($v in $videoControllers) {
        $name = ($v.Name + ' ' + $v.AdapterCompatibility)
        if ($name -match 'NVIDIA') { return 'cuda' }
    }

    # Anything else with a GPU -> Vulkan. AMD, Intel, and even older NVIDIA cards
    # without a current CUDA driver land here.
    foreach ($v in $videoControllers) {
        if ($v.AdapterRAM -gt 0) { return 'vulkan' }
    }

    Write-Warn2 'No GPU detected — falling back to Vulkan flavor (CPU-only path TBD on Windows).'
    return 'vulkan'
}

function Get-Target {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -ne 'AMD64' -and $arch -ne 'x86_64') {
        Write-Err "ClosedMesh on Windows requires x86_64. Detected: $arch"
        Write-Err "ARM64 Windows is not yet supported. Build from source: https://github.com/$Repo"
        throw 'Unsupported architecture.'
    }

    $flavor = Detect-Backend
    if ($flavor -notin @('cuda', 'vulkan')) {
        Write-Err "Unsupported Windows backend: $flavor"
        Write-Err "Set `$env:CLOSEDMESH_BACKEND = 'cuda' or 'vulkan' to override."
        throw 'Unsupported backend.'
    }
    return "windows-x86_64-$flavor"
}

function Download-Binary {
    param([string]$Target)

    $asset = "closedmesh-$Target.zip"
    $url = "https://github.com/$Repo/releases/latest/download/$asset"
    $tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString()))

    try {
        Write-Info "Downloading $asset from $Repo..."
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile (Join-Path $tmp $asset)
        } catch {
            Write-Err "Failed to download $url"
            Write-Err 'If your hardware does not have a release artifact yet, try'
            Write-Err "  `$env:CLOSEDMESH_BACKEND = 'vulkan'; iwr -useb https://closedmesh.com/install.ps1 | iex"
            Write-Err 'or build from source: https://github.com/' + $Repo
            throw
        }

        Write-Info 'Extracting...'
        Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $tmp -Force

        $binSrc = Join-Path $tmp 'closedmesh.exe'
        if (-not (Test-Path $binSrc)) {
            throw "Extracted archive did not contain closedmesh.exe at $binSrc"
        }

        if (-not (Test-Path $InstallDir)) {
            New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        }

        Copy-Item -Force $binSrc (Join-Path $InstallDir 'closedmesh.exe')
        Write-Ok "Installed: $InstallDir\closedmesh.exe"
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

function Add-PathHint {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if (($userPath -split ';') -contains $InstallDir) { return }

    Write-Info "Adding $InstallDir to your user PATH..."
    $newPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Warn2 'PATH updated. New shells will pick it up automatically; existing shells need to reopen.'
}

function Install-ScheduledTaskUnit {
    $bin = Join-Path $InstallDir 'closedmesh.exe'
    if (-not (Test-Path $bin)) {
        Write-Err "Cannot register Scheduled Task: $bin does not exist."
        return
    }

    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }

    # Re-register: nuke any existing task with the same name to keep the
    # installer idempotent.
    schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null

    # `serve --auto --publish --mesh-name closedmesh ...` discovers and
    # joins the public ClosedMesh through the canonical entry node at
    # mesh.closedmesh.com, AND advertises this node on Nostr so peers
    # and the public entry can find it. Without --publish closedmesh.com
    # shows "0 models" even when joined.
    #
    # `--join-url` is preferred (the runtime re-fetches the token on
    # every restart so an entry-node key rotation doesn't strand
    # installs), but we only embed it when the installed CLI actually
    # understands the flag — closedmesh-llm < v0.65.0 crashloops with
    # `error: unexpected argument '--join-url'`. For older CLIs we
    # embed a literal `--join <token>` fetched at install-time instead.
    $supportsJoinUrl = $false
    try {
        $help = & $bin serve --help 2>&1 | Out-String
        if ($help -match '--join-url') { $supportsJoinUrl = $true }
        else {
            $help2 = & $bin serve --help-advanced 2>&1 | Out-String
            if ($help2 -match '--join-url') { $supportsJoinUrl = $true }
        }
    } catch {
        $supportsJoinUrl = $false
    }

    $joinSegment = ''
    if ($supportsJoinUrl) {
        $joinSegment = ' --join-url https://mesh.closedmesh.com/api/status'
        Write-Info 'CLI supports --join-url; embedding it in the Scheduled Task.'
    } else {
        $token = $null
        try {
            $resp  = Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 -Uri 'https://mesh.closedmesh.com/api/status'
            $json  = $resp.Content | ConvertFrom-Json
            if ($json.token) { $token = [string]$json.token }
        } catch {
            $token = $null
        }
        if ($token) {
            $joinSegment = " --join $token"
            Write-Info 'Older CLI without --join-url; embedded a fresh invite token.'
        } else {
            Write-Warn2 'Could not embed a join arg (older CLI, entry node unreachable).'
            Write-Warn2 'Service will fall back to Nostr auto-discovery.'
        }
    }

    $argString = "serve --auto --publish --mesh-name closedmesh${joinSegment} --headless"
    $action    = New-ScheduledTaskAction    -Execute $bin -Argument $argString -WorkingDirectory $env:USERPROFILE
    $trigger   = New-ScheduledTaskTrigger   -AtLogOn -User $env:USERNAME
    $settings  = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -RestartCount 3 `
        -ExecutionTimeLimit (New-TimeSpan -Days 0)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'ClosedMesh - private LLM mesh node' | Out-Null

    Write-Ok "Registered Scheduled Task: $TaskName"

    if (-not $NoStartService) {
        try {
            Start-ScheduledTask -TaskName $TaskName
            Write-Ok 'Started ClosedMesh service'
        } catch {
            Write-Warn2 "Could not auto-start the service. Try: Start-ScheduledTask -TaskName $TaskName"
        }
    } else {
        Write-Ok "Service installed (not started). Start later: Start-ScheduledTask -TaskName $TaskName"
    }
}

function Invoke-Install {
    Write-Info 'Installing ClosedMesh - private LLM mesh on the compute you already own.'
    Write-Info "Repo:    https://github.com/$Repo"
    Write-Info "Bin dir: $InstallDir"

    $target = Get-Target
    Write-Info "Target:  $target"

    Download-Binary -Target $target

    try {
        $null = & (Join-Path $InstallDir 'closedmesh.exe') --version 2>&1
        if ($LASTEXITCODE -ne 0) { throw "closedmesh --version exited $LASTEXITCODE" }
    } catch {
        Write-Err 'Installed binary did not run cleanly. Aborting.'
        throw
    }

    if ($Service) { Install-ScheduledTaskUnit }

    Add-PathHint

    Write-Host ''
    Write-Host '  ClosedMesh installed.'
    Write-Host ''
    Write-Host '  Try:'
    Write-Host '    closedmesh --version'
    Write-Host '    closedmesh serve --auto              # foreground (joins the public mesh)'
    if ($Service) {
        Write-Host "    Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo  # service status"
        Write-Host "    Stop-ScheduledTask -TaskName $TaskName                          # stop the service"
    }
    Write-Host ''
    Write-Host '  Open the chat at https://closedmesh.com (or http://localhost:3000 if you ran the local app).'
    Write-Host ''
}

# When the script is fetched and piped to iex, the function below is exposed
# so the user can re-invoke with arguments (e.g. -Service). The script also
# runs Invoke-Install once on dot-source unless CLOSEDMESH_INSTALL_NO_AUTO=1.
function closedmesh-install {
    [CmdletBinding()]
    param(
        [switch]$Service,
        [switch]$NoStartService,
        [string]$InstallDir,
        [string]$Repo,
        [string]$Backend
    )
    if ($Service)         { $script:Service        = $true }
    if ($NoStartService)  { $script:NoStartService = $true }
    if ($InstallDir)      { $script:InstallDir     = $InstallDir }
    if ($Repo)            { $script:Repo           = $Repo }
    if ($Backend)         { $script:Backend        = $Backend }
    Invoke-Install
}

if (-not $env:CLOSEDMESH_INSTALL_NO_AUTO) {
    Invoke-Install
}
