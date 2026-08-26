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
$LauncherPath = Join-Path $RuntimeDir 'sidecar.launch.ps1'
$ServerPath = Join-Path $Root 'server.py'

if (Test-Path $PidPath) {
  $Existing = [int](Get-Content -Raw $PidPath)
  $ExistingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$Existing" -ErrorAction SilentlyContinue
  if ($ExistingProcess -and $ExistingProcess.Name -eq 'python.exe' -and $ExistingProcess.CommandLine -like "*$ServerPath*") {
    $ExistingHealth = $null
    try { $ExistingHealth = Invoke-RestMethod -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/health" } catch {}
    if ($ExistingHealth -and $ExistingHealth.status -eq 'ready') {
      Write-Output "Embedding sidecar already running: PID $Existing"
      exit 0
    }
    $TaskKill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $Stopped = Start-Process -FilePath $TaskKill -ArgumentList @('/PID', [string]$Existing, '/T', '/F') -NoNewWindow -Wait -PassThru
    if ($Stopped.ExitCode -ne 0) { throw "stale sidecar taskkill failed with exit $($Stopped.ExitCode)" }
    Write-Output "Stopped unhealthy embedding sidecar: PID $Existing"
  }
  Remove-Item -LiteralPath $PidPath -Force
  Write-Output "Removed stale embedding sidecar PID record: $Existing"
}

function ConvertTo-PsLiteral([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
$Launcher = @(
  "`$ErrorActionPreference = 'Stop'",
  ("Set-Location " + (ConvertTo-PsLiteral $Root)),
  ("& " + (ConvertTo-PsLiteral $Python) + " " + (ConvertTo-PsLiteral (Join-Path $Root 'server.py')) + " --host 127.0.0.1 --port $Port --cache-dir " + (ConvertTo-PsLiteral $ModelCache) + " 1>>" + (ConvertTo-PsLiteral $OutPath) + " 2>>" + (ConvertTo-PsLiteral $ErrPath)),
  'exit $LASTEXITCODE'
) -join [Environment]::NewLine
[System.IO.File]::WriteAllText($LauncherPath, $Launcher + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($OutPath, '', (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($ErrPath, '', (New-Object System.Text.UTF8Encoding($false)))
$Outer = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $LauncherPath) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
$DiscoverDeadline = [DateTime]::UtcNow.AddSeconds(10)
$ProcessId = 0
do {
  $Candidate = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'python.exe' -and $_.CommandLine -like "*$ServerPath*" -and $_.CommandLine -like '*\.venv\Scripts\python.exe*'
  } | Select-Object -First 1
  if ($Candidate) { $ProcessId = [int]$Candidate.ProcessId; break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $DiscoverDeadline)
if ($ProcessId -le 0) { throw "sidecar launcher PID $($Outer.Id) did not expose the uv Python process" }
[System.IO.File]::WriteAllText($PidPath, [string]$ProcessId, (New-Object System.Text.UTF8Encoding($false)))
$Deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $ReadyTimeoutSeconds))
do {
  $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $Process) {
    $Tail = if (Test-Path $ErrPath) { (Get-Content -Tail 20 $ErrPath) -join [Environment]::NewLine } else { '' }
    throw "Embedding sidecar exited during startup: $Tail"
  }
  try {
    $Health = Invoke-RestMethod -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/health"
    if ($Health.status -eq 'ready') {
      Write-Output "Embedding sidecar ready: PID $ProcessId, model=$($Health.model), revision=$($Health.revision), dimensions=$($Health.dimensions)"
      exit 0
    }
  } catch {}
  Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $Deadline)
throw "Embedding sidecar did not become ready within $ReadyTimeoutSeconds seconds; inspect $ErrPath"
