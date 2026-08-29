[CmdletBinding()]
param(
  [ValidateSet('Release', 'Debug')]
  [string]$Configuration = 'Release',
  [string]$Architecture = 'x64'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'native/runtime-supervisor'
$build = Join-Path $root 'packaging/e08/supervisor-build'
$output = Join-Path $root 'packaging/e08/runtime-supervisor'

if ($env:OS -ne 'Windows_NT' -and -not $IsWindows) { throw 'The runtime supervisor must be built with MSVC on Windows.' }
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) { throw 'cmake is required (Visual Studio C++ workload).' }

New-Item -ItemType Directory -Force -Path $build, $output | Out-Null
cmake -S $source -B $build -G 'Visual Studio 17 2022' -A $Architecture
cmake --build $build --config $Configuration --parallel
$binary = Join-Path $build "$Configuration/runtime-supervisor.exe"
if (-not (Test-Path $binary)) { throw "MSVC supervisor output missing: $binary" }
Copy-Item -Force $binary (Join-Path $output 'runtime-supervisor.exe')
$hash = Get-FileHash (Join-Path $output 'runtime-supervisor.exe') -Algorithm SHA256
[pscustomobject]@{
  path = 'packaging/e08/runtime-supervisor/runtime-supervisor.exe'
  sha256 = $hash.Hash.ToLowerInvariant()
  configuration = $Configuration
  architecture = $Architecture
} | ConvertTo-Json -Compress
