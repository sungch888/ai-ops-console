# AI Operations Management Platform - demo launcher (Windows, no Python needed)
# Serves the built demo pages with a built-in Windows HTTP listener.
$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Join-Path $base 'dist'
$rootFull = [System.IO.Path]::GetFullPath($root)
$port = 8090
$listener = New-Object System.Net.HttpListener
$started = $false
while ($port -le 8099 -and -not $started) {
  try {
    $listener.Prefixes.Add("http://127.0.0.1:$port/")
    $listener.Start()
    $started = $true
  } catch {
    $listener = New-Object System.Net.HttpListener
    $port++
  }
}
if (-not $started) { Write-Host '[ERROR] No free port between 8090 and 8099.'; exit 1 }
$url = "http://127.0.0.1:$port/"
Write-Host "Demo URL: $url"
Write-Host 'Opening browser. Press Ctrl+C to stop the server.'
Start-Process $url
$map = @{}
$map['.html'] = 'text/html; charset=utf-8'
$map['.js'] = 'application/javascript; charset=utf-8'
$map['.css'] = 'text/css; charset=utf-8'
$map['.json'] = 'application/json'
$map['.svg'] = 'image/svg+xml'
$map['.png'] = 'image/png'
$map['.jpg'] = 'image/jpeg'
$map['.gif'] = 'image/gif'
$map['.ico'] = 'image/x-icon'
$map['.woff'] = 'font/woff'
$map['.woff2'] = 'font/woff2'
$map['.ttf'] = 'font/ttf'
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($rel -eq '/' -or $rel -eq '') { $rel = '/index.html' }
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
    if ((-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) -or (-not (Test-Path -LiteralPath $full -PathType Leaf))) {
      $ctx.Response.StatusCode = 404
      $ctx.Response.OutputStream.Close()
      continue
    }
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $ext = [System.IO.Path]::GetExtension($full).ToLower()
    if ($map.ContainsKey($ext)) { $ctx.Response.ContentType = $map[$ext] } else { $ctx.Response.ContentType = 'application/octet-stream' }
    $ctx.Response.StatusCode = 200
    $ctx.Response.ContentLength = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.OutputStream.Close()
  } catch {
    try { $ctx.Response.StatusCode = 500; $ctx.Response.OutputStream.Close() } catch { }
  }
}
