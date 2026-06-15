// NetMon Widget Renderer
const dlVal = document.getElementById('dlVal')
const ulVal = document.getElementById('ulVal')
const dlUnit = document.getElementById('dlUnit')
const ulUnit = document.getElementById('ulUnit')
const dlBar = document.getElementById('dlBar')
const ulBar = document.getElementById('ulBar')
const ipAddr = document.getElementById('ipAddr')
const ipLoc = document.getElementById('ipLoc')

// Change detection cache
let prevDlVal = '', prevUlVal = ''
let prevDlUnit = '', prevUlUnit = ''
let prevDlPct = -1, prevUlPct = -1

function formatSpeed(bps) {
  bps = Math.abs(bps)
  if (bps < 1024) return { v: bps.toFixed(1), u: 'B/s' }
  if (bps < 1048576) return { v: (bps / 1024).toFixed(1), u: 'KB/s' }
  if (bps < 1073741824) return { v: (bps / 1048576).toFixed(1), u: 'MB/s' }
  return { v: (bps / 1073741824).toFixed(2), u: 'GB/s' }
}

window.netmon.onSpeedUpdate((dlBps, ulBps) => {
  const dl = formatSpeed(dlBps)
  const ul = formatSpeed(ulBps)

  if (dl.v !== prevDlVal) { dlVal.textContent = dl.v; prevDlVal = dl.v }
  if (dl.u !== prevDlUnit) { dlUnit.textContent = dl.u; prevDlUnit = dl.u }
  if (ul.v !== prevUlVal) { ulVal.textContent = ul.v; prevUlVal = ul.v }
  if (ul.u !== prevUlUnit) { ulUnit.textContent = ul.u; prevUlUnit = ul.u }

  const barMax = Math.max(dlBps, ulBps, 1048576) * 1.3
  const dlPct = Math.round(Math.min(dlBps / barMax * 100, 100))
  const ulPct = Math.round(Math.min(ulBps / barMax * 100, 100))

  if (dlPct !== prevDlPct) { dlBar.style.width = dlPct + '%'; prevDlPct = dlPct }
  if (ulPct !== prevUlPct) { ulBar.style.width = ulPct + '%'; prevUlPct = ulPct }
})

window.netmon.onIPUpdate((ip, loc) => {
  ipAddr.textContent = ip
  ipLoc.textContent = loc
  ipLoc.title = loc
})

// Esc to hide to tray
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.netmon.hideToTray()
})
