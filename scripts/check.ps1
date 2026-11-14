$ErrorActionPreference = 'Stop'
Write-Host 'Checking Sahaj local API http://localhost:3000 ...'
$health = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -Method Get
if (-not $health.ok -or $health.emergency_ready) { throw 'Unexpected health response' }
Write-Host 'PASS: API process is running (emergency features not ready)'

foreach ($route in @('/api/sarvam/tool/ping', '/api/cron/tick')) {
  try {
    Invoke-WebRequest -Uri ('http://localhost:3000' + $route) -Method Post -UseBasicParsing | Out-Null
    throw "FAIL: $route accepted a request with no secret"
  } catch {
    $status = [int]$_.Exception.Response.StatusCode
    if ($status -notin @(401,503)) { throw "FAIL: $route status $status" }
    Write-Host "PASS: $route blocks missing credentials ($status)"
  }
}
Write-Host 'Scaffold smoke checks passed. DB, voice, and event processing still require implementation.'
