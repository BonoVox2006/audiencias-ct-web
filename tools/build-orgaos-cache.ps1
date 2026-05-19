$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outFile = Join-Path $root "data\orgaos-cache.json"
$script:COD_TIPOS_TEMPORARIA = @(3, 4, 5, 7, 10)

function Invoke-CamaraJson([string]$url) {
  $c = New-Object System.Net.WebClient
  $c.Headers.Add("Accept", "application/json")
  $c.Headers.Add("User-Agent", "AudienciasCT-Prototype/1.0")
  $c.Encoding = [Text.Encoding]::UTF8
  return $c.DownloadString($url)
}

function Classify-Temporaria($orgao) {
  $cod = 0
  try { $cod = [int]$orgao.codTipoOrgao } catch {}
  if ($script:COD_TIPOS_TEMPORARIA -contains $cod) { return "temporaria" }
  return $null
}

function Is-Active($orgao) {
  if (-not $orgao.dataFim) { return $true }
  try { return ([datetime]$orgao.dataFim) -ge (Get-Date) } catch { return $true }
}

function Get-OrgaosPorCodigo([int]$cod) {
  $all = @()
  $page = 1
  while ($page -le 10) {
    $orgUrl = "https://dadosabertos.camara.leg.br/api/v2/orgaos?codTipoOrgao={0}&itens=100&pagina={1}&ordem=ASC&ordenarPor=sigla" -f $cod, $page
    $resp = (Invoke-CamaraJson $orgUrl) | ConvertFrom-Json
    if (-not $resp.dados) { break }
    $rows = @($resp.dados)
    if ($rows.Count -eq 0) { break }
    $all += $rows
    if ($rows.Count -lt 100) { break }
    $page++
  }
  return $all
}

function Get-OrgaoPorSigla([string]$sigla) {
  $url = "https://dadosabertos.camara.leg.br/api/v2/orgaos?sigla={0}&itens=5" -f [Uri]::EscapeDataString($sigla.Trim())
  $resp = (Invoke-CamaraJson $url) | ConvertFrom-Json
  if (-not $resp.dados) { return $null }
  $rows = @($resp.dados)
  if ($rows.Count -eq 0) { return $null }
  return $rows[0]
}

$byId = @{}
foreach ($cod in $script:COD_TIPOS_TEMPORARIA) {
  foreach ($o in (Get-OrgaosPorCodigo $cod)) {
    if (-not (Is-Active $o)) { continue }
    if ((Classify-Temporaria $o) -ne "temporaria") { continue }
    $byId[[string]$o.id] = @{
      id = $o.id
      sigla = $o.sigla
      nome = $(if ($o.apelido) { $o.apelido } else { $o.nome })
      tipoOrgao = $o.tipoOrgao
      codTipoOrgao = $o.codTipoOrgao
    }
  }
}

foreach ($siglaFix in @("CEXBRLEG")) {
  $ox = Get-OrgaoPorSigla $siglaFix
  if ($ox -and (Is-Active $ox) -and ((Classify-Temporaria $ox) -eq "temporaria")) {
    $byId[[string]$ox.id] = @{
      id = $ox.id
      sigla = $ox.sigla
      nome = $(if ($ox.apelido) { $ox.apelido } else { $ox.nome })
      tipoOrgao = $ox.tipoOrgao
      codTipoOrgao = $ox.codTipoOrgao
    }
  }
}

$list = @($byId.Values | Sort-Object { $_.sigla })
$payload = @{
  dados = $list
  build = "cache"
  fetchedAt = (Get-Date).ToString("o")
}

$dir = Split-Path $outFile
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$json = $payload | ConvertTo-Json -Depth 8 -Compress
[System.IO.File]::WriteAllText($outFile, $json, [Text.UTF8Encoding]::new($false))
Write-Host "Cache: $outFile ($($list.Count) orgaos, CEXBRLEG=$(($list.sigla -contains 'CEXBRLEG')))"
