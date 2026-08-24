[CmdletBinding()]
param(
  [string]$ModelCache = 'E:\deepseek_memory\.models\multilingual-e5-small',
  [switch]$SkipModelDownload
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Root '.venv'
$Python = Join-Path $Venv 'Scripts\python.exe'
$Uv = (Get-Command uv.exe -ErrorAction Stop).Source

function Invoke-Checked {
  param([string]$FilePath, [string[]]$Arguments, [string]$Step)
  $Process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $Root -NoNewWindow -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "$Step failed with exit $($Process.ExitCode)" }
}

if (-not (Test-Path $Python)) {
  Invoke-Checked $Uv @('venv', '--python', '3.12', $Venv) 'create sidecar venv'
}
Invoke-Checked $Uv @('pip', 'install', '--link-mode', 'copy', '--python', $Python, '--requirement', (Join-Path $Root 'requirements.txt')) 'install sidecar packages'
Invoke-Checked $Python @('-m', 'unittest', '-v', (Join-Path $Root 'test_contract.py')) 'sidecar contract tests'
if (-not $SkipModelDownload) {
  Invoke-Checked $Python @((Join-Path $Root 'server.py'), '--cache-dir', $ModelCache, '--download-only') 'download pinned E5 model'
}
Write-Output "Embedding sidecar setup complete: $Python"
