const http    = require('node:http')
const fsSync  = require('node:fs')
const fs      = require('node:fs/promises')
const path    = require('node:path')
const crypto  = require('node:crypto')

const PORT = Number(process.env.PORT || 3000)
const ROOT = __dirname

loadEnv()

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`
const DATA_DIR = path.join(ROOT, '.data')
const USERS_PATH = path.join(DATA_DIR, 'users.json')
const oauthStates = new Map()
const sessions = new Map()
const SESSION_COOKIE = 'sd_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

const OAUTH = {
  youtube: {
    name: 'YouTube',
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri: process.env.YOUTUBE_REDIRECT_URI || `${PUBLIC_BASE_URL}/auth/youtube/callback`,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile https://www.googleapis.com/auth/youtube.readonly'
  },
  twitch: {
    name: 'Twitch',
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    redirectUri: process.env.TWITCH_REDIRECT_URI || `${PUBLIC_BASE_URL}/auth/twitch/callback`,
    authUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scope: 'user:read:email'
  }
}

// ═══════════════════════════════════════════════════════════════════
// SSE — overlays conectados
// ═══════════════════════════════════════════════════════════════════
const sseClients = new Set()

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    try { client.write(payload) }
    catch { sseClients.delete(client) }
  }
  console.log(`[SSE] broadcast → ${sseClients.size} cliente(s):`, data.type)
}

// ═══════════════════════════════════════════════════════════════════
// SERVIDOR HTTP
// ═══════════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  // handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = (req.url || '/').split('?')[0]

  try {
    if (req.method === 'GET' && (url === '/' || url === '/index.html'))
      return serveFile(res, 'index.html', 'text/html; charset=utf-8')

    if (req.method === 'GET' && url === '/login.html')
      return serveFile(res, 'login.html', 'text/html; charset=utf-8')

    if (req.method === 'GET' && url === '/donate.html')
      return serveFile(res, 'donate.html', 'text/html; charset=utf-8')

    if (req.method === 'GET' && url === '/overlay.html')
      return serveFile(res, 'overlay.html', 'text/html; charset=utf-8')

    if (req.method === 'GET' && url === '/dashboard.html')
      return serveDashboard(req, res)

    if (req.method === 'GET' && url === '/api/auth/me')
      return getCurrentUser(req, res)

    if (req.method === 'POST' && url === '/api/auth/signup')
      return signup(req, res)

    if (req.method === 'POST' && url === '/api/auth/login')
      return login(req, res)

    if (req.method === 'POST' && url === '/api/auth/logout')
      return logout(req, res)

    if (req.method === 'GET' && url === '/api/alerts/stream')
      return handleSSE(req, res)

    if (req.method === 'GET' && url === '/api/connections')
      return getUserConnections(req, res)

    if (req.method === 'GET' && url === '/auth/youtube')
      return startOAuth(req, res, 'youtube')

    if (req.method === 'GET' && url === '/auth/twitch')
      return startOAuth(req, res, 'twitch')

    if (req.method === 'GET' && url === '/auth/youtube/callback')
      return finishOAuth(req, res, 'youtube')

    if (req.method === 'GET' && url === '/auth/twitch/callback')
      return finishOAuth(req, res, 'twitch')

    if (req.method === 'POST' && url === '/api/create-donation')
      return createDonation(req, res)

    if (req.method === 'POST' && url === '/api/abacatepay/webhook')
      return handleWebhook(req, res)

    if (req.method === 'POST' && url === '/api/test-alert')
      return handleTestAlert(req, res)

    return sendJson(res, 404, { error: 'Rota não encontrada.' })
  } catch (err) {
    console.error('[SERVER ERROR]', {
      url,
      method: req.method,
      error: err.message,
      stack: err.stack
    })
    return sendJson(res, 500, { error: 'Erro interno no servidor.' })
  }
})

server.listen(PORT, () => {
  console.log('')
  console.log(`🚀 SpaceDonate rodando em ${PUBLIC_BASE_URL}`)
  console.log(`   Formulário : ${PUBLIC_BASE_URL}/donate.html`)
  console.log(`   Overlay OBS: ${PUBLIC_BASE_URL}/overlay.html`)
  console.log(`   Teste       : ${PUBLIC_BASE_URL}/overlay.html?test=true`)
  console.log('')
  console.log('   OBS → Browser Source → URL acima | 1920×1080 | fundo transparente ✓')
  console.log('')
  console.warn('⚠️  Modo placeholder — nenhuma cobrança real será criada.')
  console.log('')
})

// ═══════════════════════════════════════════════════════════════════
// SSE handler
// ═══════════════════════════════════════════════════════════════════
function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  })
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)

  sseClients.add(res)
  console.log(`[SSE] overlay conectado · total: ${sseClients.size}`)

  const ping = setInterval(() => { try { res.write(': ping\n\n') } catch { clearInterval(ping) } }, 25_000)

  req.on('close', () => {
    sseClients.delete(res)
    clearInterval(ping)
    console.log(`[SSE] overlay desconectado · restantes: ${sseClients.size}`)
  })
}

// ═══════════════════════════════════════════════════════════════════
// CRIAR COBRANÇA (placeholder)
// ═══════════════════════════════════════════════════════════════════
// Auth.
async function signup(req, res) {
  const body = await readJson(req)
  const email = normalizeEmail(body.email)
  const password = String(body.password || '')
  const creatorName = String(body.creatorName || '').trim().slice(0, 50)

  if (!creatorName) return sendJson(res, 400, { error: 'Informe o nome do canal.' })
  if (!isValidEmail(email)) return sendJson(res, 400, { error: 'Informe um e-mail valido.' })
  if (password.length < 8) return sendJson(res, 400, { error: 'A senha precisa ter pelo menos 8 caracteres.' })

  const users = await readUsers()
  if (users.some(user => user.email === email))
    return sendJson(res, 409, { error: 'Ja existe uma conta com este e-mail.' })

  const user = {
    id: crypto.randomUUID(),
    creatorName,
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  }
  users.push(user)
  await writeUsers(users)
  createSession(res, user.id)
  return sendJson(res, 201, { ok: true, user: publicUser(user) })
}

async function login(req, res) {
  const body = await readJson(req)
  const email = normalizeEmail(body.email)
  const password = String(body.password || '')
  const users = await readUsers()
  const user = users.find(item => item.email === email)

  if (!user || !verifyPassword(password, user.passwordHash))
    return sendJson(res, 401, { error: 'E-mail ou senha invalidos.' })

  createSession(res, user.id)
  return sendJson(res, 200, { ok: true, user: publicUser(user) })
}

async function logout(req, res) {
  const token = getSessionToken(req)
  if (token) sessions.delete(token)
  clearSessionCookie(res)
  return sendJson(res, 200, { ok: true })
}

async function getCurrentUser(req, res) {
  const user = await requireUser(req)
  if (!user) return sendJson(res, 401, { user: null })
  return sendJson(res, 200, { user: publicUser(user) })
}

async function serveDashboard(req, res) {
  const user = await requireUser(req)
  if (!user) return redirect(res, '/login.html?auth=login_required')
  return serveFile(res, 'dashboard.html', 'text/html; charset=utf-8')
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = Date.now() + SESSION_TTL_MS
  sessions.set(token, { userId, expiresAt })
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

async function requireUser(req) {
  const token = getSessionToken(req)
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt < Date.now()) {
    sessions.delete(token)
    return null
  }
  const users = await readUsers()
  return users.find(user => user.id === session.userId) || null
}

function getSessionToken(req) {
  return parseCookies(req.headers.cookie || '')[SESSION_COOKIE]
}

async function readUsers() {
  try {
    return JSON.parse(await fs.readFile(USERS_PATH, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

async function writeUsers(users) {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(USERS_PATH, JSON.stringify(users, null, 2))
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex')
  return `pbkdf2$sha256$210000$${salt}$${hash}`
}

function verifyPassword(password, stored) {
  const [method, digest, iterations, salt, hash] = String(stored || '').split('$')
  if (method !== 'pbkdf2' || digest !== 'sha256' || !iterations || !salt || !hash) return false
  const candidate = crypto.pbkdf2Sync(password, salt, Number(iterations), 32, 'sha256')
  const expected = Buffer.from(hash, 'hex')
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function publicUser(user) {
  return {
    id: user.id,
    creatorName: user.creatorName,
    email: user.email,
    createdAt: user.createdAt
  }
}

// OAuth YouTube/Twitch.
async function startOAuth(req, res, provider) {
  const cfg = OAUTH[provider]
  const user = await requireUser(req)
  if (!user) return redirect(res, '/login.html?auth=login_required')

  const missing = missingOAuthConfig(cfg, provider)
  if (missing.length)
    return redirect(res, `/login.html?oauth_error=${encodeURIComponent(`Configure ${missing.join(', ')} no .env antes de conectar ${cfg.name}.`)}`)

  const state = crypto.randomBytes(24).toString('hex')
  oauthStates.set(state, { provider, userId: user.id, createdAt: Date.now() })
  pruneOAuthStates()

  const params = {
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: cfg.scope,
    state
  }

  if (provider === 'youtube') {
    params.access_type = 'offline'
    params.include_granted_scopes = 'true'
    params.prompt = 'consent'
  }

  res.writeHead(302, {
    Location: `${cfg.authUrl}?${new URLSearchParams(params)}`,
    'Set-Cookie': `sd_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`
  })
  res.end()
}

async function finishOAuth(req, res, provider) {
  const cfg = OAUTH[provider]
  const requestUrl = new URL(req.url, PUBLIC_BASE_URL)
  const error = requestUrl.searchParams.get('error')
  if (error)
    return redirect(res, `/login.html?oauth_error=${encodeURIComponent(`${cfg.name}: autorizacao cancelada ou negada.`)}`)

  const code = requestUrl.searchParams.get('code')
  const state = requestUrl.searchParams.get('state')
  const cookieState = parseCookies(req.headers.cookie || '').sd_oauth_state
  const savedState = oauthStates.get(state)

  if (!code || !state || state !== cookieState || savedState?.provider !== provider)
    return redirect(res, `/login.html?oauth_error=${encodeURIComponent(`${cfg.name}: estado OAuth invalido. Tente conectar novamente.`)}`)

  oauthStates.delete(state)

  try {
    const users = await readUsers()
    const user = users.find(item => item.id === savedState.userId)
    if (!user) return redirect(res, `/login.html?oauth_error=${encodeURIComponent(`${cfg.name}: usuario nao encontrado. Entre novamente.`)}`)

    const token = await exchangeCodeForToken(provider, code)
    const profile = await fetchProviderProfile(provider, token)
    user.connections = user.connections || {}
    user.connections[provider] = {
      connected: true,
      provider,
      displayName: profile.displayName,
      channelId: profile.channelId,
      login: profile.login,
      connectedAt: new Date().toISOString(),
      token
    }
    await writeUsers(users)
    return redirect(res, `/dashboard.html?connected=${provider}`)
  } catch (err) {
    console.error(`[OAuth] ${cfg.name}`, err)
    return redirect(res, `/login.html?oauth_error=${encodeURIComponent(`${cfg.name}: falha ao concluir conexao. Confira client secret, redirect URI e scopes.`)}`)
  }
}

async function exchangeCodeForToken(provider, code) {
  const cfg = OAUTH[provider]
  const response = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: cfg.redirectUri
    })
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error_description || data.error || `Token HTTP ${response.status}`)
  return data
}

async function fetchProviderProfile(provider, token) {
  if (provider === 'youtube') {
    const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error?.message || `YouTube profile HTTP ${response.status}`)
    const channel = data.items?.[0]
    return {
      displayName: channel?.snippet?.title || 'Canal YouTube',
      channelId: channel?.id || '',
      login: ''
    }
  }

  const response = await fetch('https://api.twitch.tv/helix/users', {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Client-Id': OAUTH.twitch.clientId
    }
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || `Twitch profile HTTP ${response.status}`)
  const user = data.data?.[0]
  return {
    displayName: user?.display_name || user?.login || 'Canal Twitch',
    channelId: user?.id || '',
    login: user?.login || ''
  }
}

async function getUserConnections(req, res) {
  const user = await requireUser(req)
  if (!user) return sendJson(res, 401, { error: 'Entre para ver conexoes.' })
  const connections = user.connections || {}
  return sendJson(res, 200, {
    youtube: publicConnection(connections.youtube),
    twitch: publicConnection(connections.twitch)
  })
}

function publicConnection(connection) {
  if (!connection?.connected) return { connected: false }
  return {
    connected: true,
    displayName: connection.displayName,
    channelId: connection.channelId,
    login: connection.login,
    connectedAt: connection.connectedAt
  }
}

function missingOAuthConfig(cfg, provider) {
  const prefix = provider.toUpperCase()
  const missing = []
  if (!cfg.clientId) missing.push(`${prefix}_CLIENT_ID`)
  if (!cfg.clientSecret) missing.push(`${prefix}_CLIENT_SECRET`)
  return missing
}

function pruneOAuthStates() {
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const [state, data] of oauthStates) {
    if (data.createdAt < cutoff) oauthStates.delete(state)
  }
}

function parseCookies(header) {
  return Object.fromEntries(header.split(';').map(part => {
    const idx = part.indexOf('=')
    if (idx === -1) return ['', '']
    return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())]
  }).filter(([key]) => key))
}

function redirect(res, location) {
  res.writeHead(302, { Location: location })
  res.end()
}

async function createDonation(req, res) {
  const body     = await readJson(req)
  const donation = normalizeDonation(body)

  if (!donation.name || !Number.isFinite(donation.amount) || donation.amount < 1)
    return sendJson(res, 400, { error: 'Informe nome e valor mínimo de R$1,00.' })

  const data = buildPlaceholderPix(donation)
  return sendJson(res, 201, {
    id:          data.id,
    amount:      data.amount,
    status:      data.status,
    brCode:      data.brCode,
    brCodeBase64: data.brCodeBase64,
    expiresAt:   data.expiresAt
  })
}

function buildPlaceholderPix(donation) {
  const id     = `placeholder-${Date.now()}`
  const amount = toCents(donation.amount)
  const slug   = donation.name.replace(/\s+/g, '-').toUpperCase()
  const brCode = [
    '000201', '010212', '26PLACEHOLDER-SPACEDONATE',
    `52DONATE-${slug}`, `54${donation.amount.toFixed(2)}`,
    '5802BR', '5909PLACEHOLDER', '6009SAO PAULO', `62${id}`, '6304FAKE'
  ].join('')

  return {
    id,
    amount,
    status:      'PENDING_PLACEHOLDER',
    brCode,
    brCodeBase64: buildQrSvg(donation, amount),
    expiresAt:   new Date(Date.now() + 3_600_000).toISOString()
  }
}

function buildQrSvg(donation, amount) {
  const label = (amount / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">
  <rect width="220" height="220" fill="white"/>
  <rect x="16" y="16" width="52" height="52" fill="#111"/>
  <rect x="152" y="16" width="52" height="52" fill="#111"/>
  <rect x="16" y="152" width="52" height="52" fill="#111"/>
  <rect x="30" y="30" width="24" height="24" fill="white"/>
  <rect x="166" y="30" width="24" height="24" fill="white"/>
  <rect x="30" y="166" width="24" height="24" fill="white"/>
  <g fill="#111">
    <rect x="88" y="20" width="12" height="12"/><rect x="112" y="20" width="12" height="12"/>
    <rect x="88" y="44" width="36" height="12"/><rect x="84" y="84" width="12" height="12"/>
    <rect x="108" y="84" width="12" height="12"/><rect x="132" y="84" width="36" height="12"/>
    <rect x="84" y="108" width="48" height="12"/><rect x="156" y="108" width="12" height="12"/>
    <rect x="180" y="108" width="12" height="12"/><rect x="84" y="132" width="12" height="12"/>
    <rect x="120" y="132" width="72" height="12"/><rect x="84" y="156" width="48" height="12"/>
    <rect x="156" y="156" width="12" height="36"/><rect x="180" y="180" width="12" height="12"/>
  </g>
  <text x="110" y="207" text-anchor="middle" font-family="monospace" font-size="9" fill="#555">PIX PLACEHOLDER · ${escapeSvg(label)}</text>
</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

function escapeSvg(v) {
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK AbacatePay
// ═══════════════════════════════════════════════════════════════════
async function handleWebhook(req, res) {
  const body   = await readJson(req)
  console.log('[Webhook]', JSON.stringify(body, null, 2))

  const charge = body.data || body
  const status = (charge.status || '').toUpperCase()
  const isPaid = status === 'PAID' || status === 'COMPLETED' || status === 'ACTIVE'

  if (!isPaid) {
    console.log(`[Webhook] status "${status}" ignorado.`)
    return sendJson(res, 200, { ok: true, ignored: true })
  }

  const meta = charge.metadata || charge.data?.metadata || {}
  broadcast({
    type:    'donation',
    name:    meta.donor_name    || 'Anônimo',
    message: meta.donor_message || '',
    amount:  charge.amount      || 0,
    id:      charge.id          || charge.externalId || '',
  })

  return sendJson(res, 200, { ok: true })
}

// ═══════════════════════════════════════════════════════════════════
// ALERTA DE TESTE  →  POST /api/test-alert
// ═══════════════════════════════════════════════════════════════════
async function handleTestAlert(req, res) {
  const body = await readJson(req)
  const donation = {
    type:    'donation',
    name:    body.name    || 'TestViewer',
    message: body.message || 'Esse é um alerta de teste! 🔥',
    amount:  body.amount  || 5000,
    id:      'test-' + Date.now(),
  }
  broadcast(donation)
  return sendJson(res, 200, { ok: true, sent: donation })
}

// ═══════════════════════════════════════════════════════════════════
// UTILITÁRIOS
// ═══════════════════════════════════════════════════════════════════
function normalizeDonation(b) {
  return {
    name:    String(b.name    || '').trim().slice(0, 40),
    amount:  roundMoney(Number(b.amount)),
    email:   String(b.email   || '').trim().slice(0, 120),
    message: String(b.message || '').trim().slice(0, 180),
  }
}

function roundMoney(v) { return Math.round(v * 100) / 100 }
function toCents(v)    { return Math.round(v * 100) }

async function serveFile(res, fileName, contentType) {
  const content = await fs.readFile(path.join(ROOT, fileName))
  res.writeHead(200, { 'Content-Type': contentType })
  res.end(content)
}

async function readJson(req) {
  let raw = ''
  try {
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 20_000) throw new Error('Payload muito grande.')
    }
    if (!raw) return {}
    return JSON.parse(raw)
  } catch (err) {
    console.error('[readJson] Erro ao parsear JSON:', {
      length: raw.length,
      raw: raw.slice(0, 100),
      error: err.message
    })
    throw err
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function loadEnv() {
  try {
    const text = fsSync.readFileSync(path.join(ROOT, '.env'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const sep = t.indexOf('=')
      if (sep === -1) continue
      const key = t.slice(0, sep).trim()
      const val = t.slice(sep + 1).trim().replace(/^["']|["']$/g, '')
      if (key && process.env[key] === undefined) process.env[key] = val
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}
