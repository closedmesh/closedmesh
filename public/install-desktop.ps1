# ClosedMesh Desktop installer - Windows x86_64.
#
#   iwr -useb https://closedmesh.com/install-desktop.ps1 | iex
#
# What it does:
#   1. Resolves the latest desktop-v* GitHub Release.
#   2. Downloads ClosedMesh_<version>_x64-setup.exe (NSIS installer).
#   3. Runs it silently and waits for it to finish.
#   4. Optionally launches ClosedMesh once installation completes.
#
# This is a *companion* to the runtime installer (install.ps1). The
# desktop app is a UI shell; it does not host inference. Install the
# runtime separately:
#
#     iwr -useb https://closedmesh.com/install.ps1 | iex
#
# Override points (rarely needed):
#   $env:CLOSEDMESH_DESKTOP_REPO = 'closedmesh/closedmesh'
#   $env:CLOSEDMESH_DESKTOP_VERSION = 'desktop-v0.1.0'  # pin a release

[CmdletBinding()]
param(
    [string]$Repo,
    [string]$Version,
    [switch]$NoLaunch,
    [switch]$Msi
)

$ErrorActionPreference = 'Stop'

if (-not $Repo) {
    $Repo = if ($env:CLOSEDMESH_DESKTOP_REPO) { $env:CLOSEDMESH_DESKTOP_REPO } else { 'closedmesh/closedmesh' }
}
if (-not $Version) {
    $Version = if ($env:CLOSEDMESH_DESKTOP_VERSION) { $env:CLOSEDMESH_DESKTOP_VERSION } else { '' }
}

$tagPrefix = 'desktop-v'

function Info($msg)  { Write-Host "[closedmesh-desktop] $msg" -ForegroundColor Cyan }
function Warn($msg)  { Write-Host "[closedmesh-desktop] $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "[closedmesh-desktop] $msg" -ForegroundColor Red; exit 1 }

# TLS 1.2 is required to talk to api.github.com on PS5 hosts (Windows 10
# without recent updates still defaults to 1.0/1.1).
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Invoke-GitHub($path) {
    $headers = @{
        'Accept'               = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'closedmesh-desktop-installer'
    }
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
    return Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo$path"
}

# --------------------------------------------------------------------------
# Resolve release.
# --------------------------------------------------------------------------
if ($Version) {
    Info "Pinned to $Version"
    $release = Invoke-GitHub "/releases/tags/$Version"
}
else {
    Info "Resolving latest release of $Repo..."
    try {
        $candidate = Invoke-GitHub '/releases/latest'
        if ($candidate.tag_name -like "$tagPrefix*") {
            $release = $candidate
        }
    }
    catch {
        # /releases/latest 404s on a repo without any published releases;
        # fall through to the list lookup below.
    }
    if (-not $release) {
        Info "Falling back to release list..."
        $list = Invoke-GitHub '/releases?per_page=20'
        $release = $list | Where-Object { (-not $_.draft) -and (-not $_.prerelease) -and ($_.tag_name -like "$tagPrefix*") } | Select-Object -First 1
    }
}

if (-not $release) {
    Fail "couldn't find a published $tagPrefix* release. Try the GitHub releases page directly: https://github.com/$Repo/releases"
}

$tagName = $release.tag_name
$versionNumber = $tagName.Substring($tagPrefix.Length)

# --------------------------------------------------------------------------
# Pick the right asset.
#
# Default: the NSIS .exe installer (`*_x64-setup.exe`) - much smaller and
# friendlier for non-technical users than the .msi. Pass -Msi to force
# the MSI variant for IT-managed deployments.
# --------------------------------------------------------------------------
if ($Msi) {
    $asset = $release.assets | Where-Object { $_.name -like '*_x64*.msi' } | Select-Object -First 1
    $assetKind = 'MSI'
}
else {
    $asset = $release.assets | Where-Object { $_.name -like '*_x64-setup.exe' } | Select-Object -First 1
    $assetKind = 'NSIS installer'
    if (-not $asset) {
        Warn "No NSIS installer in this release - falling back to MSI."
        $asset = $release.assets | Where-Object { $_.name -like '*_x64*.msi' } | Select-Object -First 1
        $assetKind = 'MSI'
    }
}

if (-not $asset) {
    Fail "no Windows asset in release $tagName. See https://github.com/$Repo/releases/tag/$tagName"
}

# --------------------------------------------------------------------------
# Download.
# --------------------------------------------------------------------------
$tempDir = Join-Path $env:TEMP "closedmesh-desktop-install"
if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }
New-Item -ItemType Directory -Path $tempDir | Out-Null

$installerPath = Join-Path $tempDir $asset.name
Info "Downloading $($asset.name) (v$versionNumber)..."
# `Invoke-WebRequest` with -OutFile already shows a progress bar; we
# silence the non-progress output by suppressing the return value.
$null = Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installerPath -UseBasicParsing

# --------------------------------------------------------------------------
# Run installer.
# --------------------------------------------------------------------------
Info "Running $assetKind silently..."
if ($Msi) {
    # /qn = no UI, /norestart = don't reboot. Logging into the temp dir so
    # failures leave a breadcrumb instead of a silent error.
    $logPath = Join-Path $tempDir 'msi-install.log'
    $proc = Start-Process -FilePath 'msiexec.exe' `
        -ArgumentList @('/i', "`"$installerPath`"", '/qn', '/norestart', '/log', "`"$logPath`"") `
        -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        Fail "msiexec exited with code $($proc.ExitCode). See $logPath"
    }
}
else {
    # NSIS installers built by Tauri honour the standard /S silent flag.
    $proc = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        Fail "installer exited with code $($proc.ExitCode)"
    }
}

# --------------------------------------------------------------------------
# Find the freshly-installed app and launch it (unless suppressed).
# --------------------------------------------------------------------------
$candidates = @(
    "$env:LOCALAPPDATA\Programs\ClosedMesh\closedmesh.exe",
    "$env:LOCALAPPDATA\ClosedMesh\closedmesh.exe",
    "$env:ProgramFiles\ClosedMesh\closedmesh.exe",
    "${env:ProgramFiles(x86)}\ClosedMesh\closedmesh.exe"
)
$installedExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($installedExe) {
    Info "Installed: $installedExe"
    if (-not $NoLaunch) {
        Info "Launching ClosedMesh..."
        Start-Process -FilePath $installedExe
    }
}
else {
    Warn "Installer succeeded but I couldn't locate closedmesh.exe in the usual places. Check your Start menu under 'ClosedMesh'."
}

Write-Host ""
Write-Host "[closedmesh-desktop] Done. v$versionNumber installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. If you haven't already, install the runtime on at least one machine:"
Write-Host "       iwr -useb https://closedmesh.com/install.ps1 | iex"
Write-Host "  2. Open ClosedMesh - the system-tray pill should show 'Mesh online'."
Write-Host "  3. Generate an invite for a teammate from the tray menu, or via:"
Write-Host "       closedmesh invite create"
