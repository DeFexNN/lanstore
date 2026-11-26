# lanstore one-command installer for Windows.
#
#   irm https://raw.githubusercontent.com/DeFexNN/lanstore/main/install.ps1 | iex
#
# Optional environment overrides:
#   $env:LANSTORE_REPO, $env:LANSTORE_APP_DIR, $env:LANSTORE_AGENT, $env:LANSTORE_TOKEN
$ErrorActionPreference = 'Stop'

$Repo = if ($env:LANSTORE_REPO) { $env:LANSTORE_REPO } else { 'https://github.com/DeFexNN/lanstore' }
$AppDir = if ($env:LANSTORE_APP_DIR) { $env:LANSTORE_APP_DIR } else { Join-Path $env:LOCALAPPDATA 'lanstore\app' }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js 20+ is required: https://nodejs.org/en/download' -ForegroundColor Red
  exit 1
}
$ver = (& $node.Source -v).Trim()
$major = [int](($ver.TrimStart('v')).Split('.')[0])
if ($major -lt 20) {
  Write-Host "Node.js 20+ is required, found $ver" -ForegroundColor Red
  exit 1
}

$Here = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'src\installer.mjs'))) {
  $Here = $PSScriptRoot
}

if (-not $Here) {
  Write-Host "==> lanstore: downloading to $AppDir"
  $parent = Split-Path $AppDir -Parent
  New-Item -ItemType Directory -Force $parent | Out-Null
  $zip = Join-Path $env:TEMP "lanstore-main.zip"
  Invoke-WebRequest -UseBasicParsing "$Repo/archive/refs/heads/main.zip" -OutFile $zip
  $staging = Join-Path $env:TEMP ("lanstore-staging-" + [guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $zip -DestinationPath $staging -Force
  $root = Get-ChildItem $staging -Directory | Select-Object -First 1
  if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
  Move-Item $root.FullName $AppDir
  Remove-Item $staging, $zip -Recurse -Force -ErrorAction SilentlyContinue
  $Here = $AppDir
}

& $node.Source (Join-Path $Here 'src\installer.mjs') @args
