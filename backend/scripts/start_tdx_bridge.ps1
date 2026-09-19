param(
    [string]$GoExecutable = "go",
    [string]$OutputDirectory = (Join-Path $env:LOCALAPPDATA "TickStockPanel/tdx-bridge"),
    [string]$Hosts = "",
    [int]$Port = 3020
)

$ErrorActionPreference = "Stop"
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535" }
$tdxSourceDirectory = Join-Path $PSScriptRoot "../app/plugins/tdx/bridge"
$tdxOutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $tdxOutputDirectory | Out-Null
$tdxBinary = Join-Path $tdxOutputDirectory "tdx-bridge.exe"
# These settings affect this process only; no system PATH/configuration changes.
if (-not $env:GOPATH) { $env:GOPATH = Join-Path $tdxOutputDirectory "gopath" }
if (-not $env:GOCACHE) { $env:GOCACHE = Join-Path $tdxOutputDirectory "gocache" }
if (-not $env:GOTMPDIR) {
    $env:GOTMPDIR = Join-Path $tdxOutputDirectory "tmp"
    New-Item -ItemType Directory -Force -Path $env:GOTMPDIR | Out-Null
}
Push-Location $tdxSourceDirectory
try {
    & $GoExecutable build -mod=readonly -trimpath -o $tdxBinary .
    if ($LASTEXITCODE -ne 0) { throw "TDX bridge build failed; Go 1.25+ and module network access are required" }
} finally {
    Pop-Location
}
if (-not (Test-Path -LiteralPath $tdxBinary -PathType Leaf)) {
    throw "Build returned but bridge executable is missing. Check disk permissions and security software quarantine logs; do not disable protection."
}
$tdxArguments = @("-listen", "127.0.0.1:$Port")
if ($Hosts) { $tdxArguments += @("-hosts", $Hosts) }
Write-Host "TDX bridge: http://127.0.0.1:$Port ; keep this window open (Ctrl+C to stop)"
try {
    & $tdxBinary @tdxArguments
} catch {
    throw "Bridge could not start: $($_.Exception.Message). If the executable disappeared, check security software quarantine logs before retrying."
}
