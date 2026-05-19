$ErrorActionPreference = "Stop"
$script:COD_TIPOS_TEMPORARIA = @(3, 4, 5, 7, 10)

function Invoke-CamaraJson([string]$url) {
  $c = New-Object System.Net.WebClient
  $c.Headers.Add("Accept", "application/json")
  $c.Encoding = [Text.Encoding]::UTF8
  return $c.DownloadString($url)
}

function Classify-Temporaria($orgao) {
  $cod = [int]$orgao.codTipoOrgao
  if ($script:COD_TIPOS_TEMPORARIA -contains $cod) { return "temporaria" }
  return $null
}

function Get-OrgaosPorCodigo([int]$cod) {
  $all = @()
  $page = 1
  while ($page -le 5) {
    $orgUrl = "https://dadosabertos.camara.leg.br/api/v2/orgaos?codTipoOrgao={0}&itens=100&pagina={1}" -f $cod, $page
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

$byId = @{}
foreach ($cod in $script:COD_TIPOS_TEMPORARIA) {
  foreach ($o in (Get-OrgaosPorCodigo $cod)) {
    if ((Classify-Temporaria $o) -ne "temporaria") { continue }
    $byId[[string]$o.id] = @{ id = $o.id; sigla = $o.sigla; nome = $o.apelido }
  }
}
$out = @($byId.Values | Sort-Object { $_.sigla })
$json = @{ dados = $out } | ConvertTo-Json -Depth 6
Write-Host "count=$($out.Count) cex=$(($out.sigla -contains 'CEXBRLEG')) bytes=$($json.Length)"
