param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $Root ".env"

# Load .env if present.
if (Test-Path $EnvPath) {
  Get-Content $EnvPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $parts = $line.Split("=", 2)
    $key   = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($key -and -not [Environment]::GetEnvironmentVariable($key, "Process")) {
      [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
  }
}

# Find a free port.
$listener     = $null
$selectedPort = $Port

for ($p = $Port; $p -lt ($Port + 20); $p++) {
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
    $l.Start()
    $listener     = $l
    $selectedPort = $p
    break
  } catch [System.Net.Sockets.SocketException] {
    if ($_.Exception.SocketErrorCode -ne [System.Net.Sockets.SocketError]::AddressAlreadyInUse) { throw }
  }
}

if (-not $listener) {
  throw "Nenhuma porta livre entre $Port e $($Port + 19). Use -Port 3050 para tentar outra faixa."
}

$PublicBaseUrl = [Environment]::GetEnvironmentVariable("PUBLIC_BASE_URL", "Process")
if (-not $PublicBaseUrl) { $PublicBaseUrl = "http://localhost:$selectedPort" }

# Banner.
Write-Host ""
Write-Host "  ============================================"
Write-Host "             SpaceDonate  v2.0"
Write-Host "  ============================================"
Write-Host ""
Write-Host "  Servidor: $PublicBaseUrl"
if ($selectedPort -ne $Port) {
  Write-Host "  Porta $Port ocupada - usando $selectedPort"
}
Write-Host ""
Write-Host "  Formulario  -> $PublicBaseUrl/donate.html"
Write-Host "  Overlay OBS -> $PublicBaseUrl/overlay.html"
Write-Host "  Teste       -> $PublicBaseUrl/overlay.html?test=true"
Write-Host ""
Write-Host "  Pressione Ctrl+C para encerrar."
Write-Host "  Modo placeholder - nenhuma cobranca real sera criada."
Write-Host ""

# HTTP helpers.
function Send-Response($Stream, [int]$Status, [string]$ContentType, [string]$Body) {
  $reason = @{200="OK";201="Created";400="Bad Request";404="Not Found";500="Internal Server Error"}[$Status]
  if (-not $reason) { $reason = "OK" }
  $bodyBytes   = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes(
    "HTTP/1.1 $Status $reason`r`nContent-Type: $ContentType`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
  )
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  $Stream.Write($bodyBytes, 0, $bodyBytes.Length)
}

function Send-Json($Stream, [int]$Status, $Data) {
  Send-Response $Stream $Status "application/json; charset=utf-8" ($Data | ConvertTo-Json -Depth 10)
}

function Send-Redirect($Stream, [string]$Location) {
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes(
    "HTTP/1.1 302 Found`r`nLocation: $Location`r`nConnection: close`r`n`r`n"
  )
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
}

function Send-SseConnected($Stream) {
  Send-Response $Stream 200 "text/event-stream; charset=utf-8" "data: {`"type`":`"connected`"}`n`n"
}

function Read-HttpRequest($Stream) {
  $reader      = [System.IO.StreamReader]::new($Stream, [System.Text.Encoding]::UTF8, $false, 1024, $true)
  $requestLine = $reader.ReadLine()
  $headers     = @{}

  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line -or $line -eq "") { break }
    $sep = $line.IndexOf(":")
    if ($sep -gt 0) {
      $headers[$line.Substring(0,$sep).Trim().ToLower()] = $line.Substring($sep+1).Trim()
    }
  }

  $body = ""
  $len  = 0
  if ($headers.ContainsKey("content-length")) { $len = [int]$headers["content-length"] }

  if ($len -gt 0) {
    $chars  = New-Object char[] $len
    $offset = 0
    while ($offset -lt $len) {
      $read = $reader.Read($chars, $offset, $len - $offset)
      if ($read -le 0) { break }
      $offset += $read
    }
    if ($offset -gt 0) { $body = -join $chars[0..($offset-1)] }
  }

  $parts = $requestLine -split " "
  return @{ method = $parts[0]; path = $parts[1]; body = $body }
}

# Placeholder Pix.
function New-PlaceholderQrUri($Donation) {
  $amt = ([double]$Donation.amount).ToString("C", [System.Globalization.CultureInfo]::GetCultureInfo("pt-BR"))
  $svg = @"
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">
  <rect width="220" height="220" fill="white"/>
  <rect x="16" y="16" width="52" height="52" fill="#111"/>
  <rect x="152" y="16" width="52" height="52" fill="#111"/>
  <rect x="16" y="152" width="52" height="52" fill="#111"/>
  <rect x="30" y="30" width="24" height="24" fill="white"/>
  <rect x="166" y="30" width="24" height="24" fill="white"/>
  <rect x="30" y="166" width="24" height="24" fill="white"/>
  <g fill="#111">
    <rect x="88" y="20" width="12" height="12"/><rect x="112" y="20" width="12" height="12"/><rect x="88" y="44" width="36" height="12"/>
    <rect x="84" y="84" width="12" height="12"/><rect x="108" y="84" width="12" height="12"/><rect x="132" y="84" width="36" height="12"/>
    <rect x="84" y="108" width="48" height="12"/><rect x="156" y="108" width="12" height="12"/><rect x="180" y="108" width="12" height="12"/>
    <rect x="84" y="132" width="12" height="12"/><rect x="120" y="132" width="72" height="12"/>
    <rect x="84" y="156" width="48" height="12"/><rect x="156" y="156" width="12" height="36"/><rect x="180" y="180" width="12" height="12"/>
  </g>
  <text x="110" y="207" text-anchor="middle" font-family="monospace" font-size="9" fill="#555">PIX PLACEHOLDER - $amt</text>
</svg>
"@
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($svg)
  return "data:image/svg+xml;base64,$([Convert]::ToBase64String($bytes))"
}

function New-PlaceholderPix($Donation) {
  $id   = "placeholder-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  $slug = $Donation.name.ToUpper().Replace(" ","-")
  return @{
    id           = $id
    amount       = [int]([Math]::Round([double]$Donation.amount * 100))
    status       = "PENDING_PLACEHOLDER"
    brCode       = "00020101021226PLACEHOLDER-SPACEDONATE52DONATE-${slug}54$($Donation.amount)5802BR5909PLACEHOLDER6009SAO PAULO62${id}6304FAKE"
    brCodeBase64 = New-PlaceholderQrUri $Donation
    expiresAt    = [DateTimeOffset]::UtcNow.AddHours(1).ToString("o")
  }
}

# Main loop.
while ($true) {
  $client = $listener.AcceptTcpClient()
  $stream = $client.GetStream()

  try {
    $req  = Read-HttpRequest $stream
    $path = ($req.path -split "\?")[0]

    if ($req.method -eq "GET" -and ($path -eq "/" -or $path -eq "/index.html")) {
      $html = Get-Content (Join-Path $Root "index.html") -Raw
      Send-Response $stream 200 "text/html; charset=utf-8" $html
      continue
    }

    if ($req.method -eq "GET" -and $path -eq "/donate.html") {
      $html = Get-Content (Join-Path $Root "donate.html") -Raw
      Send-Response $stream 200 "text/html; charset=utf-8" $html
      continue
    }

    if ($req.method -eq "GET" -and $path -eq "/overlay.html") {
      $html = Get-Content (Join-Path $Root "overlay.html") -Raw
      Send-Response $stream 200 "text/html; charset=utf-8" $html
      continue
    }

    if ($req.method -eq "GET" -and ($path -like "/auth/*" -or $path -eq "/api/connections")) {
      Send-Redirect $stream "/?oauth_error=OAuth%20real%20esta%20no%20server.js.%20Rode%20com%20Node%20para%20conectar%20YouTube%20e%20Twitch."
      continue
    }

    if ($req.method -eq "GET" -and $path -eq "/api/alerts/stream") {
      Send-SseConnected $stream
      continue
    }

    if ($req.method -eq "POST" -and $path -eq "/api/create-donation") {
      $body   = if ($req.body) { $req.body | ConvertFrom-Json } else { @{} }
      $amount = [double]$body.amount
      $name   = ([string]$body.name).Trim()

      if (-not $name -or $amount -lt 1) {
        Send-Json $stream 400 @{ error = "Informe nome e valor minimo de R`$1,00." }
        continue
      }

      $donation = @{
        name    = $name.Substring(0, [Math]::Min(40, $name.Length))
        amount  = [Math]::Round($amount, 2)
        email   = ([string]$body.email).Trim()
        message = ([string]$body.message).Trim()
      }

      $charge = New-PlaceholderPix $donation
      Send-Json $stream 201 @{
        id           = $charge.id
        amount       = $charge.amount
        status       = $charge.status
        brCode       = $charge.brCode
        brCodeBase64 = $charge.brCodeBase64
        expiresAt    = $charge.expiresAt
      }
      continue
    }

    Send-Json $stream 404 @{ error = "Rota nao encontrada." }
  } catch {
    Write-Host "  [erro] $_"
    try { Send-Json $stream 500 @{ error = "Erro ao processar requisicao." } } catch {}
  } finally {
    $stream.Close()
    $client.Close()
  }
}
