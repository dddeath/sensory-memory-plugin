[CmdletBinding()]
param(
  [int]$Port = 8765,
  [string]$ModelCache = 'E:\deepseek_memory\.models\multilingual-e5-small',
  [string]$RuntimeDir = 'E:\deepseek_memory\.runtime\embedding-sidecar',
  [int]$ReadyTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $Python)) { throw 'Run setup-once.ps1 first' }
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$PidPath = Join-Path $RuntimeDir 'pid.txt'
$OutPath = Join-Path $RuntimeDir 'stdout.log'
$ErrPath = Join-Path $RuntimeDir 'stderr.log'

if (Test-Path $PidPath) {
  $Existing = [int](Get-Content -Raw $PidPath)
  if (Get-Process -Id $Existing -ErrorAction SilentlyContinue) {
    Write-Output "Embedding sidecar already running: PID $Existing"
    exit 0
  }
}

$Arguments = @(
  (Join-Path $Root 'server.py'),
  '--host', '127.0.0.1',
  '--port', [string]$Port,
  '--cache-dir', $ModelCache
)
$Process = Start-Process -FilePath $Python -ArgumentList $Arguments -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $OutPath -RedirectStandardError $ErrPath -PassThru
[System.IO.File]::WriteAllText($PidPath, [string]$Process.Id, (New-Object System.Text.UTF8Encoding($false)))
$Deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $ReadyTimeoutSeconds))
do {
  if ($Process.HasExited) {
    $Tail = if (Test-Path $ErrPath) { (Get-Content -Tail 20 $ErrPath) -join [Environment]::NewLine } else { '' }
    throw "Embedding sidecar exited during startup: $Tail"
  }
  try {
    $Health = Invoke-RestMethod -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/health"
    if ($Health.status -eq 'ready') {
      Write-Output "Embedding sidecar ready: PID $($Process.Id), model=$($Health.model), revision=$($Health.revision), dimensions=$($Health.dimensions)"
      exit 0
    }
  } catch {}
  Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $Deadline)
throw "Embedding sidecar did not become ready within $ReadyTimeoutSeconds seconds; inspect $ErrPath"
