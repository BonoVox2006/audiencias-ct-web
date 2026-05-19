$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 5175
$script:SERVER_BUILD = "2026-05-19d"

function Get-SafeFileName([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return "x" }
  $x = $s -replace '[^\w\-\.]', '_'
  if ($x.Length -gt 120) { $x = $x.Substring(0, 120) }
  return $x
}

function Get-EventStateDir([string]$eventId) {
  Join-Path $root ("data\event-state\" + (Get-SafeFileName $eventId))
}

function Load-EventPhotosFromDisk([string]$eventId) {
  $photos = @{}
  $dir = Join-Path (Get-EventStateDir $eventId) "photos"
  if (-not (Test-Path -LiteralPath $dir)) { return $photos }
  foreach ($f in Get-ChildItem -LiteralPath $dir -File -Filter "*.dat") {
    $personId = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    try {
      $photos[$personId] = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8)
    } catch {}
  }
  return $photos
}

function Save-EventPhotosToDisk([string]$eventId, $photosHash) {
  $dir = Join-Path (Get-EventStateDir $eventId) "photos"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $keep = New-Object 'System.Collections.Generic.HashSet[string]'
  if ($photosHash) {
    foreach ($personId in $photosHash.Keys) {
      $url = [string]$photosHash[$personId]
      if ([string]::IsNullOrWhiteSpace($url)) { continue }
      $fname = (Get-SafeFileName $personId) + ".dat"
      [void]$keep.Add($fname)
      [IO.File]::WriteAllText((Join-Path $dir $fname), $url, [Text.Encoding]::UTF8)
    }
  }
  foreach ($f in Get-ChildItem -LiteralPath $dir -File -Filter "*.dat") {
    if (-not $keep.Contains($f.Name)) {
      Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
    }
  }
}

function Load-EventMetaFromDisk([string]$eventId) {
  $metaFile = Join-Path (Get-EventStateDir $eventId) "meta.json"
  if (-not (Test-Path -LiteralPath $metaFile)) { return $null }
  try {
    return (Get-Content -LiteralPath $metaFile -Raw -Encoding UTF8) | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Save-EventMetaToDisk($entry) {
  $dir = Get-EventStateDir $entry.eventId
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $statuses = @{}
  if ($entry.statuses -is [hashtable]) {
    foreach ($p in $entry.statuses.GetEnumerator()) { $statuses[$p.Key] = $p.Value }
  } elseif ($entry.statuses) {
    foreach ($p in $entry.statuses.PSObject.Properties) { $statuses[$p.Name] = $p.Value }
  }
  $meta = @{
    eventId = [string]$entry.eventId
    statuses = $statuses
    version = [int]$entry.version
    updatedAt = $entry.updatedAt
  }
  $metaFile = Join-Path $dir "meta.json"
  [IO.File]::WriteAllText($metaFile, ($meta | ConvertTo-Json -Depth 12 -Compress), [Text.Encoding]::UTF8)
}

function Build-EventEntry([string]$eventId) {
  $meta = Load-EventMetaFromDisk $eventId
  $photos = Load-EventPhotosFromDisk $eventId
  $statuses = @{}
  $version = 0
  $updatedAt = $null
  if ($meta) {
    if ($meta.statuses) {
      foreach ($p in $meta.statuses.PSObject.Properties) { $statuses[$p.Name] = $p.Value }
    }
    try { $version = [int]$meta.version } catch { $version = 0 }
    $updatedAt = $meta.updatedAt
  }
  return @{
    eventId = $eventId
    statuses = $statuses
    photos = $photos
    version = $version
    updatedAt = $updatedAt
  }
}

function Get-ContentType([string]$path) {
  switch ([IO.Path]::GetExtension($path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8" }
    ".css" { "text/css; charset=utf-8" }
    ".js" { "application/javascript; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    default { "application/octet-stream" }
  }
}

function Write-HttpResponse($stream, [int]$statusCode, [string]$contentType, [byte[]]$body) {
  $reason = switch ($statusCode) { 200 { "OK" } 400 { "Bad Request" } 404 { "Not Found" } 500 { "Internal Server Error" } default { "OK" } }
  $header =
    "HTTP/1.1 $statusCode $reason`r`n" +
    "Content-Type: $contentType`r`n" +
    "Content-Length: $($body.Length)`r`n" +
    "Access-Control-Allow-Origin: *`r`n" +
    "Connection: close`r`n`r`n"
  $hb = [Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($hb, 0, $hb.Length)
  if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
}

function Get-Query([string]$rawPath) {
  $h = @{}
  if ($rawPath -notlike "*`?*") { return $h }
  $qs = $rawPath.Split("?", 2)[1]
  foreach ($pair in $qs.Split("&")) {
    if ([string]::IsNullOrWhiteSpace($pair)) { continue }
    $kv = $pair.Split("=", 2)
    $k = [Uri]::UnescapeDataString($kv[0])
    $v = if ($kv.Length -eq 2) { [Uri]::UnescapeDataString($kv[1]) } else { "" }
    $h[$k] = $v
  }
  return $h
}

function Invoke-CamaraJson([string]$url) {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor 3072 } catch {}
  $client = New-Object System.Net.WebClient
  $client.Headers.Add("Accept", "application/json")
  $client.Headers.Add("User-Agent", "AudienciasCT-Prototype/1.0")
  $client.Encoding = [Text.Encoding]::UTF8
  return $client.DownloadString($url)
}

function NormalizeFold([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return "" }
  $formD = $s.Trim().ToLowerInvariant().Normalize([Text.NormalizationForm]::FormD)
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $formD.ToCharArray()) {
    $cat = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch)
    if ($cat -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
      [void]$sb.Append($ch)
    }
  }
  return $sb.ToString()
}

# Especial=3, CPI=4, Externa=5, Sindicancia=7, GT=10 (referencia tiposOrgao)
$script:COD_TIPOS_TEMPORARIA = @(3, 4, 5, 7, 10)

function Classify-Temporaria($orgao) {
  $cod = 0
  try { $cod = [int]$orgao.codTipoOrgao } catch {}
  if ($script:COD_TIPOS_TEMPORARIA -contains $cod) { return 'temporaria' }

  $text = NormalizeFold("$($orgao.tipoOrgao) $($orgao.descricaoTipo) $($orgao.nome) $($orgao.apelido) $($orgao.sigla) $($orgao.nomePublicacao)")
  $sigla = NormalizeFold($orgao.sigla)
  if ($text -match 'subcomissao' -or $sigla.StartsWith('sub')) { return $null }
  if ($text -match 'comissao mista') { return $null }
  if ($text -match 'medida provisoria' -or $sigla.StartsWith('mpv') -or $cod -eq 9) { return $null }
  if ($text -match 'comissao permanente') { return 'permanente' }
  if ($text -match 'comissao especial') { return 'temporaria' }
  if ($text -match 'comissao externa') { return 'temporaria' }
  if ($text -match 'cpi|comissao parlamentar de inquerito') { return 'temporaria' }
  if ($text -match 'grupo de trabalho' -or $sigla.StartsWith('gt')) { return 'temporaria' }
  if ($text -match 'sindicancia') { return 'temporaria' }
  return $null
}

function Get-OrgaosPorCodigo([int]$cod) {
  $all = @()
  $page = 1
  while ($page -le 40) {
    $orgUrl = ('https://dadosabertos.camara.leg.br/api/v2/orgaos?codTipoOrgao={0}&itens=100&pagina={1}&ordem=ASC&ordenarPor=sigla' -f $cod, $page)
    try {
      $json = Invoke-CamaraJson $orgUrl
      $resp = $json | ConvertFrom-Json
      if (-not $resp.dados) { break }
      $rows = @($resp.dados)
      if ($rows.Count -eq 0) { break }
      $all += $rows
      if ($rows.Count -lt 100) { break }
      $page++
    } catch {
      break
    }
  }
  return $all
}

function Get-OrgaoPorSigla([string]$sigla) {
  if ([string]::IsNullOrWhiteSpace($sigla)) { return $null }
  $url = ('https://dadosabertos.camara.leg.br/api/v2/orgaos?sigla={0}&itens=5' -f [Uri]::EscapeDataString($sigla.Trim()))
  try {
    $json = Invoke-CamaraJson $url
    $resp = $json | ConvertFrom-Json
    if (-not $resp.dados) { return $null }
    $rows = @($resp.dados)
    if ($rows.Count -eq 0) { return $null }
    return $rows[0]
  } catch {
    return $null
  }
}

function Is-Active($orgao) {
  $statusText = NormalizeFold("$($orgao.situacao) $($orgao.status) $($orgao.nome) $($orgao.apelido)")
  if ($statusText -match 'arquivad|encerrad|extinta|finalizad') { return $false }
  if (-not $orgao.dataFim) { return $true }
  try { return ([datetime]$orgao.dataFim) -ge (Get-Date) } catch { return $true }
}

$listener = $null
foreach ($tryPort in 5175..5180) {
  try {
    $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Any, $tryPort)
    $l.Start()
    $listener = $l
    $port = $tryPort
    break
  } catch {
    if ($tryPort -eq 5180) {
      Write-Host "Nenhuma porta livre (5175-5180). Feche o servidor anterior ou encerre o processo na porta 5175." -ForegroundColor Red
      $busy = Get-NetTCPConnection -LocalPort 5175 -State Listen -ErrorAction SilentlyContinue
      if ($busy) {
        $pids = $busy | Select-Object -ExpandProperty OwningProcess -Unique
        Write-Host ("Em uso por: PID " + ($pids -join ", ")) -ForegroundColor DarkRed
      }
      exit 1
    }
  }
}
Write-Host "Audiencias CT - http://localhost:$port/  (build $($script:SERVER_BUILD))" -ForegroundColor Cyan
Write-Host "Pasta: $root" -ForegroundColor DarkCyan
Write-Host "Ao atualizar o codigo, feche esta janela e rode start-server.cmd de novo." -ForegroundColor Yellow

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::UTF8, $false, 8192, $true)
    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($requestLine)) { $client.Close(); continue }

    $headers = @{}
    while ($true) {
      $h = $reader.ReadLine()
      if ($h -eq $null -or $h -eq "") { break }
      $idx = $h.IndexOf(":")
      if ($idx -gt 0) {
        $hn = $h.Substring(0, $idx).Trim().ToLowerInvariant()
        $hv = $h.Substring($idx + 1).Trim()
        $headers[$hn] = $hv
      }
    }

    $parts = $requestLine.Split(" ")
    $method = if ($parts.Length -ge 1) { $parts[0].ToUpperInvariant() } else { "GET" }
    $rawPath = if ($parts.Length -ge 2) { $parts[1] } else { "/" }
    if ($rawPath -eq "/") { $rawPath = "/index.html" }

    $contentLength = 0
    if ($headers.ContainsKey("content-length")) {
      [void][int]::TryParse($headers["content-length"], [ref]$contentLength)
    }
    $requestBody = ""
    if ($contentLength -gt 0) {
      $buf = New-Object char[] $contentLength
      $read = 0
      while ($read -lt $contentLength) {
        $n = $reader.Read($buf, $read, $contentLength - $read)
        if ($n -le 0) { break }
        $read += $n
      }
      if ($read -gt 0) { $requestBody = -join $buf[0..($read - 1)] }
    }

    $pathOnly = ([Uri]::UnescapeDataString($rawPath.Split("?")[0])).TrimStart("/") -replace "/", "\"

    if ($pathOnly -eq "api\state" -or $pathOnly -eq "api/state") {
      try {
        if ($method -eq "GET") {
          $q = Get-Query $rawPath
          $eventId = if ($q.ContainsKey("eventId")) { [string]$q["eventId"] } else { "" }
          if ([string]::IsNullOrWhiteSpace($eventId)) {
            $body = [Text.Encoding]::UTF8.GetBytes('{"error":"eventId obrigatorio"}')
            Write-HttpResponse $stream 400 "application/json; charset=utf-8" $body
            $client.Close()
            continue
          }
          $entry = Build-EventEntry $eventId
          $payload = @{ dados = $entry } | ConvertTo-Json -Depth 8 -Compress
          $body = [Text.Encoding]::UTF8.GetBytes($payload)
          Write-HttpResponse $stream 200 "application/json; charset=utf-8" $body
          $client.Close()
          continue
        }

        if ($method -eq "POST") {
          if ([string]::IsNullOrWhiteSpace($requestBody)) {
            $body = [Text.Encoding]::UTF8.GetBytes('{"error":"Body JSON obrigatorio"}')
            Write-HttpResponse $stream 400 "application/json; charset=utf-8" $body
            $client.Close()
            continue
          }
          $incoming = $requestBody | ConvertFrom-Json
          $eventId = [string]$incoming.eventId
          if ([string]::IsNullOrWhiteSpace($eventId)) {
            $body = [Text.Encoding]::UTF8.GetBytes('{"error":"eventId obrigatorio"}')
            Write-HttpResponse $stream 400 "application/json; charset=utf-8" $body
            $client.Close()
            continue
          }
          $statuses = @{}
          if ($incoming.statuses) {
            foreach ($p in $incoming.statuses.PSObject.Properties) { $statuses[$p.Name] = $p.Value }
          }
          $photos = @{}
          if ($incoming.photos) {
            foreach ($p in $incoming.photos.PSObject.Properties) { $photos[$p.Name] = $p.Value }
          }
          $prev = Build-EventEntry $eventId
          $prevVersion = 0
          try { $prevVersion = [int]$prev.version } catch { $prevVersion = 0 }
          Save-EventPhotosToDisk $eventId $photos
          $entry = @{
            eventId = $eventId
            statuses = $statuses
            photos = (Load-EventPhotosFromDisk $eventId)
            version = ($prevVersion + 1)
            updatedAt = (Get-Date).ToString("o")
          }
          Save-EventMetaToDisk $entry
          $payload = @{ ok = $true; dados = $entry } | ConvertTo-Json -Depth 8 -Compress
          $body = [Text.Encoding]::UTF8.GetBytes($payload)
          Write-HttpResponse $stream 200 "application/json; charset=utf-8" $body
          $client.Close()
          continue
        }

        $body = [Text.Encoding]::UTF8.GetBytes('{"error":"Metodo nao suportado"}')
        Write-HttpResponse $stream 405 "application/json; charset=utf-8" $body
        $client.Close()
        continue
      } catch {
        $err = (@{ error = "Falha no estado compartilhado"; detail = $_.Exception.Message } | ConvertTo-Json -Compress)
        $body = [Text.Encoding]::UTF8.GetBytes($err)
        Write-HttpResponse $stream 500 "application/json; charset=utf-8" $body
        $client.Close()
        continue
      }
    }

    if ($pathOnly -eq "api\deputados" -or $pathOnly -eq "api/deputados") {
      $all = @()
      $page = 1
      while ($page -le 60) {
        $depUrl = 'https://dadosabertos.camara.leg.br/api/v2/deputados?itens=100&pagina={0}&ordem=ASC&ordenarPor=nome' -f $page
        $json = Invoke-CamaraJson $depUrl
        $resp = $json | ConvertFrom-Json
        if (-not $resp.dados -or $resp.dados.Count -eq 0) { break }
        foreach ($d in $resp.dados) {
          $all += @{ id = $d.id; nome = $d.nome; siglaPartido = $d.siglaPartido; siglaUf = $d.siglaUf; urlFoto = $d.urlFoto; email = $d.email }
        }
        if ($resp.dados.Count -lt 100) { break }
        $page++
      }
      $payload = @{ dados = $all; fetchedAt = (Get-Date).ToString("o") } | ConvertTo-Json -Depth 6
      $body = [Text.Encoding]::UTF8.GetBytes($payload)
      Write-HttpResponse $stream 200 "application/json; charset=utf-8" $body
      $client.Close()
      continue
    }

    if ($pathOnly -eq "api\orgaos" -or $pathOnly -eq "api/orgaos") {
      $cacheFile = Join-Path $root "data\orgaos-cache.json"
      if (-not (Test-Path -LiteralPath $cacheFile)) {
        $err = '{"error":"Cache ausente. Rode start-server.cmd"}'
        $body = [Text.Encoding]::UTF8.GetBytes($err)
        Write-HttpResponse $stream 503 "application/json; charset=utf-8" $body
      } else {
        $bytes = [System.IO.File]::ReadAllBytes($cacheFile)
        Write-HttpResponse $stream 200 "application/json; charset=utf-8" $bytes
      }
      $client.Close()
      continue
    }

    if ($pathOnly -eq "api\orgao" -or $pathOnly -eq "api/orgao") {
      try {
        $q = Get-Query $rawPath
        $sigla = ""
        if ($null -ne $q -and $q.ContainsKey("sigla")) { $sigla = [string]$q["sigla"] }
        if ([string]::IsNullOrWhiteSpace($sigla)) {
          $body = [Text.Encoding]::UTF8.GetBytes('{"error":"sigla obrigatoria"}')
          Write-HttpResponse $stream 400 "application/json; charset=utf-8" $body
          $client.Close()
          continue
        }
        $ox = Get-OrgaoPorSigla $sigla
        if (-not $ox) {
          $payload = '{"dados":[]}'
        } else {
          $row = @{
            id = $ox.id
            sigla = $ox.sigla
            nome = $(if ($ox.apelido) { $ox.apelido } else { $ox.nome })
            tipoOrgao = $ox.tipoOrgao
            codTipoOrgao = $ox.codTipoOrgao
          }
          $payload = (@{ dados = @($row) } | ConvertTo-Json -Depth 4 -Compress)
        }
        $body = [Text.Encoding]::UTF8.GetBytes($payload)
        Write-HttpResponse $stream 200 "application/json; charset=utf-8" $body
      } catch {
        $err = (@{ error = "Falha em /api/orgao"; detail = $_.Exception.Message } | ConvertTo-Json -Compress)
        $body = [Text.Encoding]::UTF8.GetBytes($err)
        Write-HttpResponse $stream 500 "application/json; charset=utf-8" $body
      }
      $client.Close()
      continue
    }

    if ($pathOnly -eq "api\eventos" -or $pathOnly -eq "api/eventos") {
      $q = Get-Query $rawPath
      $idOrgao = $q["idOrgao"]
      if (-not $idOrgao) {
        $body = [Text.Encoding]::UTF8.GetBytes('{"error":"idOrgao obrigatorio"}')
        Write-HttpResponse $stream 400 "application/json; charset=utf-8" $body
        $client.Close()
        continue
      }
      $itens = if ($q["itens"]) { $q["itens"] } else { "40" }
      $url = 'https://dadosabertos.camara.leg.br/api/v2/eventos?idOrgao={0}&itens={1}&ordem=DESC&ordenarPor=dataHoraInicio' -f $idOrgao, $itens
      $json = Invoke-CamaraJson $url
      $body = [Text.Encoding]::UTF8.GetBytes($json)
      Write-HttpResponse $stream 200 "application/json; charset=utf-8" $body
      $client.Close()
      continue
    }

    if ($pathOnly -eq "api\evento" -or $pathOnly -eq "api/evento") {
      try {
        $q = Get-Query $rawPath
        $id = $q["id"]
        if (-not $id) {
          $body = [Text.Encoding]::UTF8.GetBytes('{"error":"id obrigatorio"}')
          Write-HttpResponse $stream 400 "application/json; charset=utf-8" $body
          $client.Close()
          continue
        }
        $evJson = Invoke-CamaraJson ('https://dadosabertos.camara.leg.br/api/v2/eventos/{0}' -f $id)
        $ev = $evJson | ConvertFrom-Json
        $evento = if ($ev.dados) { $ev.dados } else { $ev }
        $pauta = @()
        try {
          $pautaJson = Invoke-CamaraJson ('https://dadosabertos.camara.leg.br/api/v2/eventos/{0}/pauta?itens=50' -f $id)
          $pautaResp = $pautaJson | ConvertFrom-Json
          if ($pautaResp.dados) { $pauta = @($pautaResp.dados) }
        } catch {}
        $membros = @()
        $orgaosArr = @($evento.orgaos)
        $orgaoId = if ($orgaosArr.Count -gt 0) { $orgaosArr[0].id } else { $null }
        if ($orgaoId) {
          try {
            $mJson = Invoke-CamaraJson ('https://dadosabertos.camara.leg.br/api/v2/orgaos/{0}/membros?itens=100' -f $orgaoId)
            $mResp = $mJson | ConvertFrom-Json
            if ($mResp.dados) { $membros = @($mResp.dados) }
          } catch {}
        }
        $payload = @{ evento = $evento; pauta = $pauta; membros = $membros; fetchedAt = (Get-Date).ToString("o") } | ConvertTo-Json -Depth 20 -Compress
        $body = [Text.Encoding]::UTF8.GetBytes($payload)
        Write-HttpResponse $stream 200 "application/json; charset=utf-8" $body
      } catch {
        $errPayload = @{ error = "Falha ao carregar evento"; detail = $_.Exception.Message } | ConvertTo-Json -Compress
        $body = [Text.Encoding]::UTF8.GetBytes($errPayload)
        Write-HttpResponse $stream 500 "application/json; charset=utf-8" $body
      }
      $client.Close()
      continue
    }

    $file = Join-Path $root $pathOnly
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      $body = [Text.Encoding]::UTF8.GetBytes("404")
      Write-HttpResponse $stream 404 "text/plain; charset=utf-8" $body
      $client.Close()
      continue
    }
    $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
    if ($ext -in ".html", ".css", ".js") {
      $text = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)
      $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    } else {
      $bytes = [IO.File]::ReadAllBytes($file)
    }
    Write-HttpResponse $stream 200 (Get-ContentType $file) $bytes
    $client.Close()
  } catch {
    try { $client.Close() } catch {}
  }
}
