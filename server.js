const http    = require('node:http')
const fsSync  = require('node:fs')
const fs      = require('node:fs/promises')
const path    = require('node:path')
const crypto  = require('node:crypto')
const { Pool } = require('pg')

const PORT = Number(process.env.PORT || 3000)
const ROOT = __dirname

loadEnv()

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`
const DATA_DIR       = path.join(ROOT, '.data')
const USERS_PATH     = path.join(DATA_DIR, 'users.json')
const DONATIONS_PATH = path.join(DATA_DIR, 'donations.json')
const CHARGES_PATH   = path.join(DATA_DIR, 'charges.json')
const WITHDRAWALS_PATH = path.join(DATA_DIR, 'withdrawals.json')
const DAILY_GOAL_CENTS = Number(process.env.DAILY_GOAL_CENTS || 10000)
const ABACATEPAY_BASE_URL = process.env.ABACATEPAY_BASE_URL || 'https://api.abacatepay.com'
const db = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null

// Contador de alertas enviados (em memória; reseta ao reiniciar o servidor)
let alertCount = 0
const recentAlerts = []
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

// Email (nodemailer)
let transporter = null
try {
  const nodemailer = require('nodemailer')
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    })
  }
} catch (e) {
  console.warn('nodemailer não disponível:', e.message)
}

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    try { client.write(payload) }
    catch { sseClients.delete(client) }
  }
  if (data.type === 'donation') {
    alertCount++
    registerRecentAlert(data)
  }
  console.log(`[SSE] broadcast → ${sseClients.size} cliente(s):`, data.type)
}

function registerRecentAlert(donation) {
  recentAlerts.unshift({
    id:        donation.id,
    name:      donation.name || 'Anônimo',
    amount:    donation.amount || 0,
    message:   donation.message || '',
    createdAt: donation.createdAt || new Date().toISOString()
  })
  if (recentAlerts.length > 6) recentAlerts.pop()
}

// ═══════════════════════════════════════════════════════════
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

    if (req.method === 'GET' && url === '/complete-profile.html')
      return serveProtectedPage(req, res, 'complete-profile.html')

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

    if (req.method === 'POST' && url === '/api/connections/disconnect')
      return disconnectConnection(req, res)

    if (req.method === 'GET' && url === '/api/stats')
      return getStats(req, res)

    if (req.method === 'GET' && url === '/api/recent-alerts')
      return getRecentAlerts(req, res)

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

    if (req.method === 'GET' && url === '/api/payment-status')
      return checkPaymentStatus(req, res)

    if (req.method === 'POST' && url === '/api/complete-profile')
      return handleCompleteProfile(req, res)

    if (req.method === 'GET' && url === '/wallet.html')
      return serveProtectedPage(req, res, 'wallet.html')

    if (req.method === 'GET' && url === '/api/wallet')
      return getWallet(req, res)

    if (req.method === 'POST' && url === '/api/wallet/withdraw')
      return createWithdrawal(req, res)

    if (req.method === 'GET' && url === '/api/withdrawals')
      return getWithdrawals(req, res)

    if (req.method === 'GET' && url === '/admin/withdrawals.html')
      return serveFile(res, 'admin-withdrawals.html', 'text/html; charset=utf-8')

    if (req.method === 'GET' && url === '/api/admin/withdrawals')
      return adminListWithdrawals(req, res)

    if (req.method === 'POST' && url === '/api/admin/withdrawals/update')
      return adminUpdateWithdrawal(req, res)

    if (req.method === 'POST' && url === '/api/abacatepay/webhook')
      return handleWebhook(req, res)

    if (req.method === 'POST' && url === '/api/test-alert')
      return handleTestAlert(req, res)

    if (req.method === 'GET' && isRootHtmlPage(url))
      return serveFile(res, url.slice(1), 'text/html; charset=utf-8')

    return sendJson(res, 404, { error: 'Rota não encontrada.' })
  } catch (err) {
    console.error(err)
    return sendJson(res, 500, { error: 'Erro interno no servidor.' })
  }
})

startServer().catch(err => {
  console.error('[startup]', err)
  process.exit(1)
})

async function startServer() {
  await initDatabase()
  server.listen(PORT, () => {
    console.log('')
    console.log(`SpaceDonate rodando em ${PUBLIC_BASE_URL}`)
    console.log(`   Home       : ${PUBLIC_BASE_URL}/`)
    console.log(`   Formulario : ${PUBLIC_BASE_URL}/donate.html`)
    console.log(`   Overlay OBS: ${PUBLIC_BASE_URL}/overlay.html`)
    console.log(`   Teste      : ${PUBLIC_BASE_URL}/overlay.html?test=true`)
    console.log('')
    console.log(`   Banco      : ${db ? 'PostgreSQL' : 'JSON local (.data)'}`)
    if (!process.env.ABACATEPAY_API_KEY) console.warn('   Modo placeholder - nenhuma cobranca real sera criada.')
    console.log('')
  })
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Porta ${PORT} já está em uso. Finalize o processo que ocupa esta porta ou altere a variável PORT.`)
    process.exit(1)
  }
  console.error(err)
})

// ═══════════════════════════════════════════════════════════════════
// SSE handler
// ═══════════════════════════════════════════════════════════════════
async function initDatabase() {
  if (!db) return
  const schema = await fs.readFile(path.join(ROOT, 'schema.sql'), 'utf8')
  await db.query(schema)
  await migrateJsonDataToPostgres()
}

async function migrateJsonDataToPostgres() {
  await migrateJsonCollection('users', USERS_PATH, async item => {
    await db.query(
      `INSERT INTO users (id, email, creator_name, password_hash, connections, profile, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT (id) DO NOTHING`,
      [item.id, item.email, item.creatorName || '', item.passwordHash || null, JSON.stringify(item.connections || {}), JSON.stringify(item.profile || {}), JSON.stringify(item), item.createdAt || new Date().toISOString()]
    )
  })

  await migrateJsonCollection('donations', DONATIONS_PATH, async item => {
    await db.query(
      `INSERT INTO donations (id, external_id, provider, name, message, amount, status, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (id) DO NOTHING`,
      [item.id, item.externalId || null, item.provider || 'local', item.name || 'Anonimo', item.message || '', item.amount || 0, item.status || 'PAID', JSON.stringify(item), item.createdAt || new Date().toISOString()]
    )
  })

  await migrateJsonCollection('charges', CHARGES_PATH, async item => {
    await db.query(
      `INSERT INTO charges (id, external_id, provider, status, name, email, message, amount, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (id) DO NOTHING`,
      [item.id, item.externalId || null, item.provider || 'local', item.status || 'PENDING', item.name || '', item.email || '', item.message || '', item.amount || 0, JSON.stringify(item), item.createdAt || new Date().toISOString()]
    )
  })

  await migrateJsonCollection('withdrawals', WITHDRAWALS_PATH, async item => {
    await db.query(
      `INSERT INTO withdrawals (id, user_id, method, amount, status, details, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT (id) DO NOTHING`,
      [item.id, item.userId || null, item.method || 'pix', item.amount || 0, item.status || 'PENDING', JSON.stringify(item.details || {}), JSON.stringify(item), item.createdAt || new Date().toISOString()]
    )
  })
}

async function migrateJsonCollection(table, filePath, insertItem) {
  const count = await db.query(`SELECT COUNT(*)::int AS count FROM ${table}`)
  if (count.rows[0].count > 0 || !fsSync.existsSync(filePath)) return

  const items = JSON.parse(await fs.readFile(filePath, 'utf8'))
  if (!Array.isArray(items) || items.length === 0) return

  for (const item of items) await insertItem(item)
  console.log(`[db] migrados ${items.length} registro(s) de ${path.basename(filePath)} para ${table}`)
}

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
  if (!user) return sendJson(res, 200, { user: null })
  return sendJson(res, 200, { user: publicUser(user) })
}

// Handle profile completion after OAuth signup: set email and password
async function handleCompleteProfile(req, res) {
  const user = await requireUser(req)
  if (!user) return sendJson(res, 401, { error: 'Entre para completar o perfil.' })

  const body = await readJson(req)
  const email = String(body.email || '').trim()
  const password = String(body.password || '')

  if (!email || !isValidEmail(email)) return sendJson(res, 400, { error: 'Informe um e-mail válido.' })
  if (!password || password.length < 8) return sendJson(res, 400, { error: 'A senha precisa ter ao menos 8 caracteres.' })

  const users = await readUsers()
  // check unique email
  if (users.some(u => u.email === email && u.id !== user.id))
    return sendJson(res, 409, { error: 'Já existe uma conta com este e-mail.' })

  const target = users.find(u => u.id === user.id)
  if (!target) return sendJson(res, 404, { error: 'Usuário não encontrado.' })

  target.email = email
  target.passwordHash = hashPassword(password)
  await writeUsers(users)

  return sendJson(res, 200, { ok: true })
}

async function serveDashboard(req, res) {
  const user = await requireUser(req)
  if (!user) return redirect(res, '/login.html?auth=login_required')
  return serveFile(res, 'dashboard.html', 'text/html; charset=utf-8')
}

async function serveProtectedPage(req, res, fileName) {
  const user = await requireUser(req)
  if (!user) return redirect(res, '/login.html?auth=login_required')
  return serveFile(res, fileName, 'text/html; charset=utf-8')
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
  if (db) {
    const result = await db.query('SELECT payload FROM users ORDER BY created_at ASC')
    return result.rows.map(row => row.payload)
  }

  try {
    return JSON.parse(await fs.readFile(USERS_PATH, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

async function writeUsers(users) {
  if (db) {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM users')
      for (const user of users) {
        await client.query(
          `INSERT INTO users (id, email, creator_name, password_hash, connections, profile, payload, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
           ON CONFLICT (id) DO UPDATE SET
             email = EXCLUDED.email,
             creator_name = EXCLUDED.creator_name,
             password_hash = EXCLUDED.password_hash,
             connections = EXCLUDED.connections,
             profile = EXCLUDED.profile,
             payload = EXCLUDED.payload,
             updated_at = now()`,
          [
            user.id,
            user.email,
            user.creatorName || user.creator_name || '',
            user.passwordHash || null,
            JSON.stringify(user.connections || {}),
            JSON.stringify(user.profile || {}),
            JSON.stringify(user),
            user.createdAt || new Date().toISOString()
          ]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return
  }

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
  // Allow starting OAuth both for existing authenticated users (connect)
  // and for new visitors (signup via provider). We store userId when
  // present so finishOAuth knows whether to attach to an existing user
  // or create a new account.
  const user = await requireUser(req)

  const missing = missingOAuthConfig(cfg, provider)
  if (missing.length)
    return redirect(res, `/login.html?oauth_error=${encodeURIComponent(`Configure ${missing.join(', ')} no .env antes de conectar ${cfg.name}.`)}`)

  const state = crypto.randomBytes(24).toString('hex')
  oauthStates.set(state, { provider, userId: user ? user.id : null, createdAt: Date.now() })
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
    let user = users.find(item => item.id === savedState.userId)
    const token = await exchangeCodeForToken(provider, code)
    const profile = await fetchProviderProfile(provider, token)

    // If there's no userId in the saved state, create a new user (signup via provider)
    if (!user) {
      const id = crypto.randomUUID()
      const creatorName = profile.displayName || `${provider}-${Date.now()}`
      user = {
        id,
        creatorName,
        email: profile.email || '',
        passwordHash: null,
        createdAt: new Date().toISOString(),
        connections: {}
      }
      users.push(user)
    }

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
    // create a session so user is logged in after OAuth signup/connect
    createSession(res, user.id)
    // If the account has no passwordHash (created via OAuth), ask user to complete profile
    if (!user.passwordHash) {
      return redirect(res, `/complete-profile.html?connected=${provider}`)
    }

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
  if (!user) return sendJson(res, 200, {
    youtube: publicConnection(null),
    twitch: publicConnection(null)
  })
  const connections = user.connections || {}
  return sendJson(res, 200, {
    youtube: publicConnection(connections.youtube),
    twitch: publicConnection(connections.twitch)
  })
}

async function disconnectConnection(req, res) {
  const user = await requireUser(req)
  if (!user) return sendJson(res, 401, { error: 'Entre para desconectar.' })

  const body = await readJson(req)
  const provider = String(body.provider || '').toLowerCase()
  if (!['youtube', 'twitch'].includes(provider))
    return sendJson(res, 400, { error: 'Provedor inválido.' })

  const users = await readUsers()
  const target = users.find(item => item.id === user.id)
  if (!target) return sendJson(res, 404, { error: 'Usuário não encontrado.' })

  if (!target.connections?.[provider]?.connected)
    return sendJson(res, 400, { error: 'Não há conexão ativa para desconectar.' })

  delete target.connections[provider]
  await writeUsers(users)
  return sendJson(res, 200, { ok: true, provider })
}

function publicConnection(connection) {
  if (!connection?.connected) return { connected: false }
  return {
    connected:   true,
    displayName: connection.displayName,
    channelId:   connection.channelId,
    login:       connection.login,
    connectedAt: connection.connectedAt
  }
}

// ── Stats ───────────────────────────────────────────────────────────
async function getStats(req, res) {
  const user = await requireUser(req)
  if (!user) return sendJson(res, 401, { error: 'Entre para ver estatísticas.' })

  const donations  = await readDonations()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const todayDonations = donations.filter(d =>
    new Date(d.createdAt) >= todayStart
  )
  const totalHoje = todayDonations.reduce((sum, d) => sum + (d.amount || 0), 0)
  const goalPercent = Math.min(100, Math.round(totalHoje / DAILY_GOAL_CENTS * 100))

  return sendJson(res, 200, {
    totalHoje,                              // em centavos
    totalHojeFormatado: (totalHoje / 100).toLocaleString('pt-BR', {
      style: 'currency', currency: 'BRL'
    }),
    metaHojeFormatado: (DAILY_GOAL_CENTS / 100).toLocaleString('pt-BR', {
      style: 'currency', currency: 'BRL'
    }),
    metaPercent: goalPercent,
    quantidadeHoje: todayDonations.length,
    alertasEnviados: alertCount,
    totalDoacoes: donations.length
  })
}

async function getRecentAlerts(req, res) {
  const user = await requireUser(req)
  if (!user) return sendJson(res, 401, { error: 'Entre para ver alertas recentes.' })
  return sendJson(res, 200, { alerts: recentAlerts })
}

// ── Persistência de donates ─────────────────────────────────────────
async function saveDonation(donation) {
  const donations = await readDonations()
  donations.push(donation)
  await writeDonations(donations)
}

async function readDonations() {
  if (db) {
    const result = await db.query('SELECT payload FROM donations ORDER BY created_at ASC')
    return result.rows.map(row => row.payload)
  }

  try {
    return JSON.parse(await fs.readFile(DONATIONS_PATH, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

async function writeDonations(donations) {
  if (db) {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM donations')
      for (const donation of donations) {
        await client.query(
          `INSERT INTO donations (id, external_id, provider, name, message, amount, status, payload, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
           ON CONFLICT (id) DO UPDATE SET
             external_id = EXCLUDED.external_id,
             provider = EXCLUDED.provider,
             name = EXCLUDED.name,
             message = EXCLUDED.message,
             amount = EXCLUDED.amount,
             status = EXCLUDED.status,
             payload = EXCLUDED.payload,
             updated_at = now()`,
          [
            donation.id,
            donation.externalId || donation.external_id || null,
            donation.provider || 'local',
            donation.name || 'Anonimo',
            donation.message || '',
            donation.amount || 0,
            donation.status || 'PAID',
            JSON.stringify(donation),
            donation.createdAt || new Date().toISOString()
          ]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return
  }

  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(DONATIONS_PATH, JSON.stringify(donations, null, 2))
}

async function saveCharge(charge) {
  const charges = await readCharges()
  const idx = charges.findIndex(item => item.id === charge.id || item.externalId === charge.externalId)
  if (idx >= 0) charges[idx] = { ...charges[idx], ...charge, updatedAt: new Date().toISOString() }
  else charges.push(charge)
  await writeCharges(charges)
}

async function readCharges() {
  if (db) {
    const result = await db.query('SELECT payload FROM charges ORDER BY created_at ASC')
    return result.rows.map(row => row.payload)
  }

  try {
    return JSON.parse(await fs.readFile(CHARGES_PATH, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

async function writeCharges(charges) {
  if (db) {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM charges')
      for (const charge of charges) {
        await client.query(
          `INSERT INTO charges (id, external_id, provider, status, name, email, message, amount, payload, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
           ON CONFLICT (id) DO UPDATE SET
             external_id = EXCLUDED.external_id,
             provider = EXCLUDED.provider,
             status = EXCLUDED.status,
             name = EXCLUDED.name,
             email = EXCLUDED.email,
             message = EXCLUDED.message,
             amount = EXCLUDED.amount,
             payload = EXCLUDED.payload,
             updated_at = now()`,
          [
            charge.id,
            charge.externalId || charge.external_id || null,
            charge.provider || 'local',
            charge.status || 'PENDING',
            charge.name || '',
            charge.email || '',
            charge.message || '',
            charge.amount || 0,
            JSON.stringify(charge),
            charge.createdAt || new Date().toISOString()
          ]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return
  }

  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(CHARGES_PATH, JSON.stringify(charges, null, 2))
}

// Withdrawals persistence

async function readWithdrawals() {
  if (db) {
    const result = await db.query('SELECT payload FROM withdrawals ORDER BY created_at ASC')
    return result.rows.map(row => row.payload)
  }

  try {
    return JSON.parse(await fs.readFile(WITHDRAWALS_PATH, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

async function writeWithdrawals(withdrawals) {
  if (db) {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM withdrawals')
      for (const withdrawal of withdrawals) {
        await client.query(
          `INSERT INTO withdrawals (id, user_id, method, amount, status, details, payload, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
           ON CONFLICT (id) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             method = EXCLUDED.method,
             amount = EXCLUDED.amount,
             status = EXCLUDED.status,
             details = EXCLUDED.details,
             payload = EXCLUDED.payload,
             updated_at = now()`,
          [
            withdrawal.id,
            withdrawal.userId || withdrawal.user_id || null,
            withdrawal.method || 'pix',
            withdrawal.amount || 0,
            withdrawal.status || 'PENDING',
            JSON.stringify(withdrawal.details || {}),
            JSON.stringify(withdrawal),
            withdrawal.createdAt || new Date().toISOString()
          ]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return
  }

  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(WITHDRAWALS_PATH, JSON.stringify(withdrawals, null, 2))
}

async function saveWithdrawal(withdrawal) {
  const list = await readWithdrawals()
  list.push(withdrawal)
  await writeWithdrawals(list)
}

// API: get wallet totals
async function getWallet(req, res) {
  const user = await requireUser(req)
  if (!user) return sendJson(res, 401, { error: 'Entre para ver a carteira.' })

  const donations = await readDonations()
  const withdrawals = await readWithdrawals()

  const totalReceived = donations.reduce((s, d) => s + (d.amount || 0), 0)
  const totalRequested = withdrawals.reduce((s, w) => s + ((w.status === 'REJECTED') ? 0 : (w.amount || 0)), 0)
  const totalWithdrawn = withdrawals.reduce((s, w) => s + ((w.status === 'COMPLETED') ? (w.amount || 0) : 0), 0)

  const available = Math.max(0, totalReceived - totalRequested)

  return sendJson(res, 200, {
    totalReceived,
    totalRequested,
    totalWithdrawn,
    available
  })
}

// API: create withdrawal request
async function createWithdrawal(req, res) {
  const user = await requireUser(req)
  if (!user) return sendJson(res, 401, { error: 'Entre para solicitar saque.' })

  const body = await readJson(req)
  const method = String(body.method || '').toLowerCase()
  const amount = Number(body.amount || 0)
  const details = body.details || {}

  if (!['pix', 'ted'].includes(method)) return sendJson(res, 400, { error: 'Método inválido.' })
  if (!Number.isFinite(amount) || amount <= 0) return sendJson(res, 400, { error: 'Informe um valor válido.' })

  const donations = await readDonations()
  const withdrawals = await readWithdrawals()
  const totalReceived = donations.reduce((s, d) => s + (d.amount || 0), 0)
  const totalRequested = withdrawals.reduce((s, w) => s + ((w.status === 'REJECTED') ? 0 : (w.amount || 0)), 0)
  const available = Math.max(0, totalReceived - totalRequested)

  if (amount > available) return sendJson(res, 400, { error: 'Saldo insuficiente.' })

  // basic details validation
  if (method === 'pix') {
    if (!details.pixKey) return sendJson(res, 400, { error: 'Informe a chave Pix.' })
  } else {
    // ted
    if (!details.bank || !details.agency || !details.account || !details.holder) return sendJson(res, 400, { error: 'Informe dados bancários completos para TED.' })
  }

  const id = `wd-${Date.now()}`
  const record = {
    id,
    userId: user.id,
    method,
    amount: Math.round(amount), // cents expected
    details,
    status: 'PENDING',
    createdAt: new Date().toISOString()
  }

  await saveWithdrawal(record)

  // broadcast to dashboard (optional)
  broadcast({ type: 'withdrawal', id: record.id, amount: record.amount, status: record.status })

  return sendJson(res, 201, { ok: true, withdrawal: record })
}

// API: list withdrawals for current user
async function getWithdrawals(req, res) {
  const user = await requireUser(req)
  if (!user) return sendJson(res, 401, { error: 'Entre para ver saques.' })
  const list = await readWithdrawals()
  const mine = list.filter(w => w.userId === user.id).sort((a,b)=> b.createdAt.localeCompare(a.createdAt))
  return sendJson(res, 200, { withdrawals: mine })
}

// Simple admin check — use ADMIN_EMAIL in .env or set an env var ADMIN_IDS with comma-separated user ids
async function isAdmin(req) {
  // first, allow API token via header
  const headerToken = (req.headers['x-admin-token'] || req.headers['x-admin-token'.toLowerCase()])
  if (headerToken && process.env.ADMIN_TOKEN && headerToken === process.env.ADMIN_TOKEN) return true

  const user = await requireUser(req)
  if (!user) return false
  const adminEmail = process.env.ADMIN_EMAIL
  const adminIds = (process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean)
  if (adminEmail && user.email === adminEmail) return true
  if (adminIds.includes(user.id)) return true
  return false
}

// Admin: list all withdrawals
async function adminListWithdrawals(req, res) {
  if (!await isAdmin(req)) return sendJson(res, 403, { error: 'Acesso negado.' })
  const all = await readWithdrawals()
  // return most recent first
  all.sort((a,b)=> b.createdAt.localeCompare(a.createdAt))
  return sendJson(res, 200, { withdrawals: all })
}

// Admin: update withdrawal status (COMPLETED, REJECTED)
async function adminUpdateWithdrawal(req, res) {
  if (!await isAdmin(req)) return sendJson(res, 403, { error: 'Acesso negado.' })
  const body = await readJson(req)
  const id = String(body.id || '').trim()
  const status = String(body.status || '').toUpperCase()
  if (!id || !['COMPLETED','REJECTED'].includes(status)) return sendJson(res, 400, { error: 'Parâmetros inválidos.' })
  const list = await readWithdrawals()
  const w = list.find(x => x.id === id)
  if (!w) return sendJson(res, 404, { error: 'Solicitação não encontrada.' })
  w.status = status
  w.updatedAt = new Date().toISOString()
  await writeWithdrawals(list)

  // notify user by email if available
  try {
    const users = await readUsers()
    const user = users.find(u => u.id === w.userId)
    if (user?.email) {
      await sendEmailIfConfigured(user.email, `Sua solicitação ${w.id} foi ${status}`, `Olá ${user.creatorName},\n\nSua solicitação de saque (${w.method.toUpperCase()}, valor ${(w.amount/100).toFixed(2)} BRL) foi atualizada para: ${status}.\n\nAtenciosamente, SpaceDonate`)
    }
  } catch (e) { console.error('Notify failed', e.message) }

  // Optionally call AbacatePay when completed
  if (status === 'COMPLETED' && process.env.ABACATEPAY_API_KEY) {
    try { await callAbacatePayPayout(w) } catch (e) { console.error('AbacatePay Payout failed', e.message) }
  }

  return sendJson(res, 200, { ok: true, withdrawal: w })
}

// Call AbacatePay payout API (real integration using configurable endpoint)
async function callAbacatePayPayout(withdrawal) {
  const key = process.env.ABACATEPAY_API_KEY
  if (!key) throw new Error('AbacatePay API key not configured')

  const base = process.env.ABACATEPAY_BASE_URL || 'https://api.abacatepay.com'
  const payoutPath = process.env.ABACATEPAY_PAYOUT_PATH || '/payouts'
  const url = new URL(payoutPath, base).toString()

  // Build payload according to common payout APIs. Adjust fields if AbacatePay differs.
  const amountCents = Math.round(withdrawal.amount || 0)
  const payload = {
    reference: withdrawal.id,
    amount_cents: amountCents,
    currency: 'BRL',
    method: withdrawal.method,
    recipient: {}
  }

  if (withdrawal.method === 'pix') {
    payload.recipient = { type: 'pix', key: withdrawal.details.pixKey }
  } else {
    payload.recipient = {
      type: 'ted',
      bank: withdrawal.details.bank,
      agency: withdrawal.details.agency,
      account: withdrawal.details.account,
      holder: withdrawal.details.holder
    }
  }

  console.log('[AbacatePay] POST', url, payload)
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(payload),
    // timeout not directly supported by fetch; rely on environment
  })

  let body = null
  try { body = await resp.json().catch(()=>null) } catch(e) { body = null }

  // Read latest withdrawals, update record
  const list = await readWithdrawals()
  const idx = list.findIndex(x => x.id === withdrawal.id)
  if (idx === -1) throw new Error('Withdrawal record not found when updating after payout')

  const record = list[idx]
  record.payoutRequest = { url, payload }
  record.payoutResponse = body || { statusCode: resp.status }
  record.externalStatus = (body && (body.status || body.state)) || `HTTP_${resp.status}`
  record.externalId = (body && (body.id || body.externalId)) || null
  record.payoutAt = new Date().toISOString()

  if (resp.ok && record.externalStatus && /completed|paid|success|confirmed/i.test(String(record.externalStatus))) {
    record.status = 'COMPLETED'
  } else if (!resp.ok) {
    record.status = 'FAILED'
  } else {
    // API accepted the request but not yet completed
    record.status = 'PROCESSING'
  }

  record.updatedAt = new Date().toISOString()
  list[idx] = record
  await writeWithdrawals(list)

  // Notify user about payout result
  try {
    const users = await readUsers()
    const user = users.find(u => u.id === record.userId)
    if (user?.email) {
      const subject = `Atualização do saque ${record.id}: ${record.status}`
      const text = `Olá ${user.creatorName || ''},\n\nSua solicitação de saque (${record.method.toUpperCase()}, valor ${(record.amount/100).toFixed(2)} BRL) teve a seguinte atualização: ${record.status}.\n\nDetalhes externos: ${record.externalId || 'N/A'} · status: ${record.externalStatus}\n\nAtenciosamente, SpaceDonate`
      await sendEmailIfConfigured(user.email, subject, text)
    }
  } catch (e) { console.error('[AbacatePay] notify user failed', e.message) }

  return { ok: resp.ok, status: record.status, externalStatus: record.externalStatus, externalId: record.externalId }
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

  let data
  try {
    data = process.env.ABACATEPAY_API_KEY
      ? await createAbacatePayPix(donation)
      : buildPlaceholderPix(donation)
  } catch (err) {
    console.error('[AbacatePay] create donation failed', err)
    return sendJson(res, 502, { error: err.message || 'Erro ao criar cobrança Pix.' })
  }

  if (data.provider === 'placeholder') {
    const saved = {
      id:        data.id,
      name:      donation.name,
      message:   donation.message,
      amount:    data.amount,
      status:    'PAID_PLACEHOLDER',
      provider:  data.provider,
      createdAt: new Date().toISOString()
    }

    await saveDonation(saved)
    broadcast({ type: 'donation', ...saved })
  }

  return sendJson(res, 201, {
    id:          data.id,
    amount:      data.amount,
    status:      data.status,
    brCode:      data.brCode,
    brCodeBase64: data.brCodeBase64,
    expiresAt:   data.expiresAt,
    provider:    data.provider
  })
}

async function createAbacatePayPix(donation) {
  const amount = toCents(donation.amount)
  const externalId = `spacedonate-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const payload = {
    method: 'PIX',
    data: {
      amount,
      expiresIn: Number(process.env.ABACATEPAY_PIX_EXPIRES_IN || 3600),
      description: `Donate de ${donation.name}`,
      externalId,
      customer: buildAbacateCustomer(donation),
      metadata: {
        externalId,
        donor_name: donation.name,
        donor_message: donation.message || '',
        donor_email: donation.email || '',
        source: 'spacedonate'
      }
    }
  }

  const response = await fetch(new URL('/v2/transparents/create', ABACATEPAY_BASE_URL), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ABACATEPAY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.error) {
    const message = result.error?.message || result.error || `AbacatePay HTTP ${response.status}`
    throw new Error(`Erro ao criar Pix na AbacatePay: ${message}`)
  }

  const charge = result.data || result
  await saveCharge({
    id: charge.id,
    externalId,
    provider: 'abacatepay',
    status: charge.status || 'PENDING',
    name: donation.name,
    email: donation.email,
    message: donation.message,
    amount: charge.amount || amount,
    createdAt: new Date().toISOString()
  })

  return {
    id: charge.id,
    amount: charge.amount || amount,
    status: charge.status || 'PENDING',
    brCode: charge.brCode,
    brCodeBase64: charge.brCodeBase64,
    expiresAt: charge.expiresAt,
    provider: 'abacatepay'
  }
}

function buildAbacateCustomer(donation) {
  const customer = { name: donation.name }
  if (donation.email) customer.email = donation.email
  return customer
}

async function checkPaymentStatus(req, res) {
  const id = new URL(req.url || '/', PUBLIC_BASE_URL).searchParams.get('id')
  if (!id) return sendJson(res, 400, { error: 'Informe o id da cobranca.' })

  if (!process.env.ABACATEPAY_API_KEY) {
    const charges = await readCharges()
    const charge = charges.find(item => item.id === id || item.externalId === id)
    return sendJson(res, 200, { id, status: charge?.status || 'PENDING_PLACEHOLDER' })
  }

  const url = new URL('/v2/transparents/check', ABACATEPAY_BASE_URL)
  url.searchParams.set('id', id)

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${process.env.ABACATEPAY_API_KEY}` }
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.error) {
    const message = result.error?.message || result.error || `AbacatePay HTTP ${response.status}`
    return sendJson(res, response.status || 500, { error: message })
  }

  const data = result.data || result
  await saveCharge({ id: data.id || id, status: data.status, expiresAt: data.expiresAt })
  return sendJson(res, 200, data)
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
    expiresAt:   new Date(Date.now() + 3_600_000).toISOString(),
    provider:    'placeholder'
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
  const body = await readJson(req)
  console.log('[Webhook]', JSON.stringify(body, null, 2))

  if (!isValidAbacateWebhook(req))
    return sendJson(res, 401, { error: 'Webhook nao autorizado.' })

  const event = body.event || body.type || ''
  const charge = body.data || body
  const status = (charge.status || '').toUpperCase()
  const isPaid = event === 'transparent.completed' || status === 'PAID' || status === 'COMPLETED' || status === 'ACTIVE'

  if (!isPaid) {
    console.log(`[Webhook] evento/status ignorado: ${event || status || 'desconhecido'}.`)
    return sendJson(res, 200, { ok: true, ignored: true })
  }

  const meta = charge.metadata || charge.data?.metadata || {}
  const charges = await readCharges()
  const stored = charges.find(item =>
    item.id === charge.id ||
    item.externalId === charge.externalId ||
    item.externalId === meta.externalId
  )
  const id = charge.id || stored?.id || charge.externalId || meta.externalId || `wh-${Date.now()}`

  const donations = await readDonations()
  if (donations.some(item => item.id === id || item.externalId === meta.externalId)) {
    return sendJson(res, 200, { ok: true, duplicate: true })
  }

  const donation = {
    id,
    externalId: meta.externalId || charge.externalId || stored?.externalId || '',
    provider:  'abacatepay',
    name:      meta.donor_name    || stored?.name    || 'Anonimo',
    message:   meta.donor_message || stored?.message || '',
    amount:    charge.amount      || stored?.amount  || 0,
    status:    'PAID',
    createdAt: new Date().toISOString()
  }

  await saveDonation(donation)
  if (stored) await saveCharge({ ...stored, status: 'PAID', paidAt: donation.createdAt })

  broadcast({
    type:    'donation',
    name:    donation.name,
    message: donation.message,
    amount:  donation.amount,
    id:      donation.id,
  })

  return sendJson(res, 200, { ok: true })
}

// ═══════════════════════════════════════════════════════════════════
// ALERTA DE TESTE  →  POST /api/test-alert
// ═══════════════════════════════════════════════════════════════════
function isValidAbacateWebhook(req) {
  const url = new URL(req.url || '/', PUBLIC_BASE_URL)
  const expectedSecret = process.env.ABACATEPAY_WEBHOOK_SECRET
  const expectedHmacKey = process.env.ABACATEPAY_WEBHOOK_HMAC_KEY || process.env.ABACATEPAY_PUBLIC_KEY

  if (expectedSecret && url.searchParams.get('webhookSecret') !== expectedSecret) return false

  const signature = req.headers['x-webhook-signature']
  if (expectedHmacKey && signature) {
    const expected = crypto
      .createHmac('sha256', expectedHmacKey)
      .update(Buffer.from(req.rawBody || '', 'utf8'))
      .digest('base64')
    const a = Buffer.from(expected)
    const b = Buffer.from(String(signature))
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  return true
}

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

function isRootHtmlPage(url) {
  if (!/^\/[a-z0-9-]+\.html$/i.test(url)) return false
  const fileName = url.slice(1)
  return fsSync.existsSync(path.join(ROOT, fileName))
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 20_000) throw new Error('Payload muito grande.')
  }
  req.rawBody = raw
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

async function sendEmailIfConfigured(to, subject, text) {
  if (!transporter) { console.log('[Email] transporter not configured — skipping', subject); return }
  try {
    await transporter.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER, to, subject, text })
    console.log('[Email] sent to', to)
  } catch (e) { console.error('[Email] failed', e.message) }
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
