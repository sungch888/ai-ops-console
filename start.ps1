# AI Ops Console demo v2.2 - start with PowerShell (Windows, when .bat window closes too fast)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$port = 8090
$py = $null
foreach ($c in 'python', 'python3', 'py') {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if ($cmd) { $py = $c; break }
}
if (-not $py) { Write-Host 'Python 3 not found. Install Python 3.9+ from python.org.' -ForegroundColor Red; exit 1 }
function Test-Port($p) {
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $c.Close(); return $true } catch { return $false }
}
while (Test-Port $port) { $port++ }
$url = "http://127.0.0.1:$port"
Write-Host "Starting data service: $url" -ForegroundColor Cyan
Start-Process $url
& $py server/server.py --port $port --dist dist --db server/data/aiops.db
