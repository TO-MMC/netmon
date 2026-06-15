// NetMon 3.0 — Electron main process
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, net } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const Store = require('electron-store')
const initSqlJs = require('sql.js')

// ── Settings ──────────────────────────────────────
const store = new Store({
  name: 'config',
  cwd: app.getPath('userData'),
  defaults: {
    autoStart: false,
    startMinimized: false,
    interval: 2000,
    interface: 'auto',
    alwaysOnTop: true,
    widgetLocked: false,
    opacity: 1.0,
    retentionDays: 30,
    widgetX: -1,
    widgetY: -1,
  },
})

// ── Database (sql.js — pure JS SQLite, no native build) ──
const dbDir = path.join(app.getPath('userData'), 'data')
fs.mkdirSync(dbDir, { recursive: true })
const dbFile = path.join(dbDir, 'stats.db')

let db = null  // sql.js database instance

async function initDB() {
  const SQL = await initSqlJs()
  // Load existing database or create new
  if (fs.existsSync(dbFile)) {
    const buf = fs.readFileSync(dbFile)
    db = new SQL.Database(buf)
  } else {
    db = new SQL.Database()
  }
  db.run('PRAGMA journal_mode=OFF')  // simpler with manual save
  db.run(`
    CREATE TABLE IF NOT EXISTS speed_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      download_bps REAL NOT NULL,
      upload_bps REAL NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_speed_ts ON speed_records(timestamp)')
  saveDB()
}

function saveDB() {
  if (!db) return
  try { fs.writeFileSync(dbFile, Buffer.from(db.export())) } catch (_) {}
}

function recordSpeed(dl, ul) {
  if (!db) return
  try {
    db.run('INSERT INTO speed_records(download_bps, upload_bps) VALUES (?,?)', [dl, ul])
  } catch (_) {}
}

// ── Global state ──────────────────────────────────
let widgetWin = null
let settingsWin = null
let statsWin = null
let tray = null
let monitorTimer = null
let lastRecv = 0, lastSent = 0, lastTick = 0

// ── Network monitoring ────────────────────────────
function getNetBytes() {
  return new Promise((resolve) => {
    const child = spawn('netstat', ['-e'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.on('close', () => {
      const m = stdout.match(/([\d,]{5,})\s+([\d,]{5,})/)
      if (m) {
        resolve({
          recv: parseInt(m[1].replace(/,/g, '')),
          sent: parseInt(m[2].replace(/,/g, '')),
        })
      } else {
        resolve(null)
      }
    })
    child.on('error', () => resolve(null))
  })
}

async function pollSpeed() {
  const data = await getNetBytes()
  if (!data) return

  const now = Date.now()

  if (lastRecv === 0) {
    lastRecv = data.recv
    lastSent = data.sent
    lastTick = now
    return
  }

  const dt = (now - lastTick) / 1000
  if (dt <= 0) return

  const dlBps = Math.max(0, (data.recv - lastRecv) / dt)
  const ulBps = Math.max(0, (data.sent - lastSent) / dt)

  lastRecv = data.recv
  lastSent = data.sent
  lastTick = now

  recordSpeed(dlBps, ulBps)

  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.webContents.send('speed-update', dlBps, ulBps)
  }
}

// ── GeoIP ─────────────────────────────────────────
// Two-phase: (1) get real public IP via HTTPS (through proxy/VPN),
//            (2) enrich with location by explicit IP lookup.

const IP_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

function buildLoc(data) {
  const parts = []
  const cnt = data.country || data.country_name || ''
  const reg = data.region || data.regionName || data.region_name || ''
  const city = data.city || ''
  const isp = data.isp || data.org || data.organization || ''
  if (cnt && cnt !== '未知')                parts.push(cnt)
  if (reg && reg !== cnt && reg !== '未知') parts.push(reg)
  if (city && city !== reg && city !== '未知') parts.push(city)
  let loc = parts.join(' · ')
  if (isp && isp !== '未知') loc += (loc ? ' · ' : '') + isp
  return loc
}

async function fetchText(url, timeout) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeout)
  try {
    const resp = await net.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'NetMon/3.0' },
    })
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    return await resp.text()
  } finally { clearTimeout(t) }
}

async function fetchJSON(url, timeout) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeout)
  try {
    const resp = await net.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'NetMon/3.0' },
    })
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    return await resp.json()
  } finally { clearTimeout(t) }
}

async function queryGeoIP() {
  // ═══ Phase 1 — Get real public IP via HTTPS (goes through system proxy/VPN) ═══
  const ipSources = [
    { url: 'https://ifconfig.me/ip',   timeout: 4000 },
    { url: 'https://api.ipify.org/',   timeout: 4000 },
    { url: 'https://icanhazip.com/',  timeout: 4000 },
  ]

  let realIP = ''
  try {
    realIP = await Promise.any(ipSources.map(({ url, timeout }) =>
      fetchText(url, timeout).then(text => {
        const ip = text.replace(/[\r\n]/g, '').trim()
        if (!IP_REGEX.test(ip)) throw new Error('invalid ip: ' + ip)
        return ip
      })
    ))
  } catch (_) {
    return { ip: '—', loc: '查询失败' }
  }

  // ═══ Phase 2 — Enrich with location (query by explicit IP, not auto-detect) ═══
  const locSources = [
    {
      url: `http://ip-api.com/json/${realIP}?lang=zh-CN&fields=country,city,isp,regionName`,
      timeout: 4000,
    },
    { url: `https://ipapi.co/${realIP}/json/`, timeout: 5000 },
  ]

  try {
    const data = await Promise.any(locSources.map(({ url, timeout }) =>
      fetchJSON(url, timeout).then(json => {
        const returnedIP = json.ip || json.query || ''
        if (returnedIP && returnedIP !== realIP) {
          throw new Error('ip mismatch: ' + returnedIP)
        }
        return json
      })
    ))
    const loc = buildLoc(data)
    return { ip: realIP, loc }
  } catch (_) {
    // IP is correct even if location lookup failed
    return { ip: realIP, loc: '—' }
  }
}

async function pollGeoIP() {
  const result = await queryGeoIP()
  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.webContents.send('ip-update', result.ip, result.loc)
  }
}

// ── Widget window ─────────────────────────────────
function createWidget() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const x = store.get('widgetX', -1)
  const y = store.get('widgetY', -1)

  widgetWin = new BrowserWindow({
    width: 220,
    height: 100,
    x: x >= 0 ? x : sw - 236,
    y: y >= 0 ? y : sh - 116,
    transparent: true,
    frame: false,
    alwaysOnTop: store.get('alwaysOnTop', true),
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    type: 'toolbar',
    opacity: store.get('opacity', 1.0),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  widgetWin.loadFile('src/widget.html')

  // Save position on move
  widgetWin.on('moved', () => {
    const [x, y] = widgetWin.getPosition()
    store.set('widgetX', x)
    store.set('widgetY', y)
  })

  widgetWin.on('closed', () => { widgetWin = null })
}

// ── System tray ───────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png')
  tray = new Tray(iconPath)
  tray.setToolTip('NetMon — 桌面网速监控')

  const toggleLabel = () => widgetWin && widgetWin.isVisible() ? '隐藏小组件' : '显示小组件'

  const menu = Menu.buildFromTemplate([
    { label: toggleLabel(), click: toggleWidget, id: 'toggle' },
    { type: 'separator' },
    { label: '设置…', click: openSettings },
    { label: '流量统计…', click: openStats },
    { type: 'separator' },
    { label: '退出', click: () => { cleanup(); app.quit() } },
  ])

  tray.setContextMenu(menu)

  tray.on('double-click', toggleWidget)
}

function toggleWidget() {
  if (!widgetWin || widgetWin.isDestroyed()) { createWidget(); return }
  if (widgetWin.isVisible()) {
    widgetWin.hide()
  } else {
    widgetWin.show()
  }
}

// ── Settings window ───────────────────────────────
function openSettings() {
  if (settingsWin) { settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 420, height: 480,
    resizable: false,
    parent: widgetWin || undefined,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  settingsWin.loadFile('src/settings.html')
  settingsWin.on('closed', () => { settingsWin = null })
}

// ── Stats window ──────────────────────────────────
function openStats() {
  if (statsWin) { statsWin.focus(); return }
  statsWin = new BrowserWindow({
    width: 700, height: 520,
    minWidth: 500, minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  statsWin.loadFile('src/stats.html')
  statsWin.on('closed', () => { statsWin = null })
}

// ── IPC handlers ──────────────────────────────────
ipcMain.handle('get-settings', () => store.store)
ipcMain.handle('save-settings', (_, settings) => {
  store.set(settings)
  // Apply immediately
  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.setAlwaysOnTop(store.get('alwaysOnTop', true))
    widgetWin.setOpacity(store.get('opacity', 1.0))
  }
  if (monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = setInterval(pollSpeed, store.get('interval', 2000))
  }
  return true
})

function queryAll(sql, params = []) {
  if (!db) return []
  try {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  } catch (_) { return [] }
}

function queryOne(sql, params = []) {
  if (!db) return null
  try {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    if (stmt.step()) {
      const row = stmt.getAsObject()
      stmt.free()
      return row
    }
    stmt.free()
    return null
  } catch (_) { return null }
}

ipcMain.handle('get-hourly-data', () => queryAll(
  `SELECT strftime('%H', timestamp) AS h,
          AVG(download_bps) AS avg_dl, AVG(upload_bps) AS avg_ul
   FROM speed_records
   WHERE date(timestamp) = date('now','localtime')
   GROUP BY h ORDER BY h`
))

ipcMain.handle('get-daily-data', () => queryAll(
  `SELECT date(timestamp) AS d,
          AVG(download_bps) AS avg_dl, AVG(upload_bps) AS avg_ul,
          MAX(download_bps) AS max_dl, MAX(upload_bps) AS max_ul
   FROM speed_records
   WHERE timestamp >= datetime('now','localtime','-30 days')
   GROUP BY d ORDER BY d`
))

ipcMain.handle('get-today-peaks', () => {
  return queryOne(
    `SELECT COALESCE(MAX(download_bps),0) AS max_dl, COALESCE(MAX(upload_bps),0) AS max_ul
     FROM speed_records WHERE date(timestamp)=date('now','localtime')`
  ) || { max_dl: 0, max_ul: 0 }
})

ipcMain.handle('get-interfaces', async () => {
  return new Promise((resolve) => {
    const child = spawn('powershell', [
      '-NoProfile', '-Command',
      "Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty Name"
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('close', () => {
      resolve(out.split(/\r?\n/).filter(Boolean))
    })
    child.on('error', () => resolve([]))
  })
})

ipcMain.handle('close-widget', () => {
  if (widgetWin) widgetWin.hide()
})

ipcMain.handle('hide-to-tray', () => {
  if (widgetWin) widgetWin.hide()
})

// ── Cleanup ───────────────────────────────────────
function cleanup() {
  if (monitorTimer) clearInterval(monitorTimer)
  if (geoIPTimer) clearInterval(geoIPTimer)
  saveDB()
  if (db) { db.close(); db = null }
}

// ── App lifecycle ─────────────────────────────────
let geoIPTimer = null

app.whenReady().then(async () => {
  await initDB()

  createTray()
  createWidget()

  // Start monitoring
  pollSpeed()
  monitorTimer = setInterval(pollSpeed, store.get('interval', 2000))

  // Start GeoIP
  pollGeoIP()
  geoIPTimer = setInterval(pollGeoIP, 5 * 60 * 1000)

  // Periodic DB save (sql.js keeps DB in memory)
  setInterval(saveDB, 30_000)

  // Auto-start
  app.setLoginItemSettings({ openAtLogin: store.get('autoStart', false) })
})

app.on('window-all-closed', () => {
  // Don't quit — keep running in tray
})

app.on('before-quit', cleanup)
