$ErrorActionPreference = "Stop"
$root = Join-Path $env:TEMP "infozip-repro"
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive (Join-Path $env:TEMP "infozip-win.zip") $root -Force

$case = Join-Path $root "case"
$route = Join-Path $case ".next\server\app\(app)\vendas\[id]"
New-Item -ItemType Directory -Force $route | Out-Null
Set-Content -LiteralPath (Join-Path $route "page.js") -Value "page" -NoNewline
Set-Content -LiteralPath (Join-Path $route "page_client-reference-manifest.js") -Value "aux" -NoNewline

Set-Location $case
$names = @(
  ".next/server/app/(app)/vendas/[id]/page.js"
  ".next/server/app/(app)/vendas/[id]/page_client-reference-manifest.js"
)
$names -join "`n" | & (Join-Path $root "zip.exe") -X -q -nw (Join-Path $root "complete.zip") -@
& (Join-Path $root "zip.exe") -sf (Join-Path $root "complete.zip")
