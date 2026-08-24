[CmdletBinding()]
param([string]$RuntimeDir = 'E:\deepseek_memory\.runtime\embedding-sidecar')

$ErrorActionPreference = 'Stop'
$PidPath = Join-Path $RuntimeDir 'pid.txt'
if (-not (Test-Path $PidPath)) { Write-Output 'Embedding sidecar is not recorded as running'; exit 0 }
$PidValue = [int](Get-Content -Raw $PidPath)
$Process = Get-Process -Id $PidValue -ErrorAction SilentlyContinue
if ($Process) { Stop-Process -Id $PidValue -Force }
Remove-Item $PidPath -Force
Write-Output "Embedding sidecar stopped: PID $PidValue"
