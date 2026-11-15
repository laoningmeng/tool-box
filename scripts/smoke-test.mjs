#!/usr/bin/env node
/**
 * 冒烟验收：通过 CDP 连上正在运行的 Electron 应用，断言页面 / IPC 行为并截图。
 *
 * 用法：
 *   1) 先启动带调试端口的应用：
 *      npm run app -- --remote-debugging-port=9355
 *      （或直接跑 node_modules\electron\dist\electron.exe . --no-sandbox --remote-debugging-port=9355）
 *   2) node scripts/smoke-test.mjs 9355 .tmp/screenshots
 *
 * 退出码 0 = 全部通过；非 0 = 有失败项（详情见 stdout 的 JSON）。
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.argv[2] ?? '9355'
const OUT_DIR = process.argv[3] ?? path.join('.tmp', 'screenshots')
fs.mkdirSync(OUT_DIR, { recursive: true })

/* ----------------------------- CDP 最小客户端 ----------------------------- */
async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 应用还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`连接不上调试端口 ${PORT}，请确认应用是以 --remote-debugging-port=${PORT} 启动的`)
}

const target = await findTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let nextId = 1
const pending = new Map()
const consoleErrors = []
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown exception')
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' '))
    return
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(OUT_DIR, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  return file.replace(/\\/g, '/')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const record = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })

/** 轮询某个表达式直到满足条件（懒加载页面 / 后端探测都需要时间） */
async function pollUntil(expression, predicate, timeout = 10000, interval = 400) {
  const start = Date.now()
  let value
  while (Date.now() - start < timeout) {
    value = await evaluate(expression)
    if (predicate(value)) return value
    await sleep(interval)
  }
  return value
}

await send('Page.enable')
await send('Runtime.enable')
// 从无 hash 的入口重新加载，才能验证「默认路由 = 工作台」
await evaluate('location.replace(location.href.split("#")[0])')
await sleep(2500)

/* -------------------------------- 工作台 -------------------------------- */
record('document.title 含产品名', (await evaluate('document.title')).includes('穷哥们的工具箱'), await evaluate('document.title'))
record('默认路由落到工作台', (await evaluate('location.hash')) === '#/dashboard', await evaluate('location.hash'))
const navTitles = await evaluate('[...document.querySelectorAll(".nav-item__title")].map(e => e.textContent.trim())')
record('侧栏 4 个一级入口且名称正确', JSON.stringify(navTitles) === JSON.stringify(['工作台', '资源管理', '工作流管理', '系统设置']), navTitles)
const subNav = await evaluate('[...document.querySelectorAll(".nav-sub__title")].map(e => e.textContent.trim())')
record('工作流二级菜单存在', subNav.length >= 2, subNav)
const statText = await pollUntil(
  '[...document.querySelectorAll(".stat-card")].map(e => e.innerText.replace(/\\s+/g, " ").trim())',
  (list) => Array.isArray(list) && list.length === 4
)
record('工作台 4 张统计卡有数据', Array.isArray(statText) && statText.length === 4 && statText[0].includes('3'), statText)
const dashRows = await pollUntil(
  'document.querySelectorAll(".dash-table .el-table__body tbody tr").length',
  (n) => n >= 3
)
record('最近资源表格 3 行', dashRows === 3, `${dashRows} 行`)
const dashStatus = await evaluate('document.querySelector(".dash-table .el-table__body tbody tr .el-tag")?.textContent?.trim() ?? null')
record('状态列已本地化', ['运行中', '已暂停', '草稿'].includes(dashStatus), dashStatus)
await shot('01-dashboard')

/* ------------------------------- 资源管理 ------------------------------- */
await evaluate('location.hash = "#/resources"')
await sleep(1000)
const resRows = await pollUntil(
  'document.querySelectorAll(".resource-table .el-table__body tbody tr").length',
  (n) => n >= 3
)
record('资源列表 3 条示例数据', resRows === 3, `${resRows} 行`)
record(
  '页面标题切换为资源管理',
  (await evaluate('document.querySelector(".page-title")?.innerText ?? ""')).includes('资源管理'),
  await evaluate('document.querySelector(".page-title")?.innerText ?? ""')
)
await shot('02-resources')

/* ---------------------------- 资源 CRUD（IPC） ---------------------------- */
const crud = await evaluate(`(async () => {
  const created = await window.api.resource.create({
    name: '冒烟测试条目', category: '自动化验收', tags: ['smoke'], description: '临时数据，脚本结束会删除', score: 77, status: 'draft'
  })
  const afterCreate = await window.api.resource.list({ page: 1, pageSize: 50 })
  const updated = await window.api.resource.update(created.id, { status: 'active', score: 91 })
  const summaryWithExtra = await window.api.resource.summary()
  await window.api.resource.remove(created.id)
  const afterRemove = await window.api.resource.list({ page: 1, pageSize: 50 })
  const summary = await window.api.resource.summary()
  const categories = await window.api.resource.categories()
  return {
    countAfterCreate: afterCreate.total, updatedStatus: updated.status, updatedScore: updated.score,
    summaryWithExtra: summaryWithExtra.total, summaryAfterRemove: summary.total,
    categories, countAfterRemove: afterRemove.total
  }
})()`)
record('CRUD 新增成功', crud.countAfterCreate === 4, crud)
record('CRUD 更新成功', crud.updatedStatus === 'active' && crud.updatedScore === 91, `${crud.updatedStatus}/${crud.updatedScore}`)
record('CRUD 删除后回到 3 条', crud.countAfterRemove === 3, `${crud.countAfterRemove} 条`)
record(
  'summary 随增删变化且 categories 可用',
  crud.summaryWithExtra === 4 && crud.summaryAfterRemove === 3 && crud.categories.includes('默认分组'),
  `${crud.summaryWithExtra} -> ${crud.summaryAfterRemove} / ${crud.categories.join(',')}`
)

/* -------------------------------- 工作流 -------------------------------- */
await evaluate('location.hash = "#/workflow"')
await sleep(1500)
const wfRows = await pollUntil(
  'document.querySelectorAll(".el-table__body tbody tr").length',
  (n) => n >= 1
)
record('内置流程 1 个', wfRows === 1, `${wfRows} 行`)
const comfy = await evaluate(`(async () => {
  const s = await window.api.comfy.status()
  const ws = await window.api.comfy.workflows()
  return { connected: s.connected, url: s.url, error: (s.error || '').slice(0, 120), workflows: ws.length, first: ws[0]?.name ?? null }
})()`)
record('ComfyUI 未启动时不崩、给出可读错误', comfy.connected === false && Boolean(comfy.error), comfy)
record('流程列表读取成功', comfy.workflows === 1, comfy.first)
const banner = await pollUntil(
  'document.querySelector(".status-bar")?.innerText?.replace(/\\s+/g, " ").trim() ?? ""',
  (text) => typeof text === 'string' && (text.includes('未连接') || text.includes('已连接'))
)
record('工作流页显示连接状态横幅', typeof banner === 'string' && (banner.includes('未连接') || banner.includes('已连接')), banner)
await shot('03-workflow')

/* ------------------------- 系统设置 / 外观 / 深色 ------------------------- */
await evaluate('location.hash = "#/settings"')
await sleep(1000)
const tabs = await evaluate('[...document.querySelectorAll(".settings__tab")].map(e => e.innerText.replace(/\\s+/g, " ").trim())')
record('设置页 4 个分栏', tabs.length === 4, tabs)
await shot('04-settings-general')

await evaluate('document.querySelectorAll(".settings__tab")[1].click()')
await sleep(900)
const presetCount = await evaluate('document.querySelectorAll(".accent-item").length')
record('外观分栏渲染色板', presetCount >= 6, `${presetCount} 个预设`)

const accentBefore = await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--el-color-primary").trim()')
await evaluate('document.querySelectorAll(".accent-item")[2].click()')
await sleep(1000)
const accentSwitch = await evaluate(`(async () => ({
  live: getComputedStyle(document.documentElement).getPropertyValue("--el-color-primary").trim(),
  stored: (await window.api.settings.get()).accentColor
}))()`)
record('点色板切换主题色即时生效', accentSwitch.stored.toLowerCase() === '#10b981' && accentSwitch.live.toLowerCase() === '#10b981', { before: accentBefore, ...accentSwitch })
await evaluate('document.querySelectorAll(".accent-item")[0].click()')
await sleep(1000)
record('主题色可切回靛蓝', (await evaluate('(async () => (await window.api.settings.get()).accentColor)()')).toLowerCase() === '#4f46e5', '#4f46e5')
await shot('05-settings-appearance')

// 深色模式：先确保从浅色出发，避免点到「已选中」的空操作
const modeAtStart = await evaluate('(async () => (await window.api.settings.get()).themeMode)()')
if (modeAtStart !== 'light') {
  await evaluate('document.querySelectorAll(".theme-card")[0].click()')
  await sleep(1000)
}
await evaluate('document.querySelectorAll(".theme-card")[1].click()')
await sleep(1300)
const dark = await evaluate(`(async () => ({
  dark: document.documentElement.classList.contains("dark"),
  stored: (await window.api.settings.get()).themeMode,
  bg: getComputedStyle(document.body).backgroundColor
}))()`)
record('深色模式切换并持久化', dark.dark === true && dark.stored === 'dark', { modeAtStart, ...dark })
await shot('06-dark-settings')
await evaluate('location.hash = "#/dashboard"')
await sleep(1100)
await shot('07-dark-dashboard')
await evaluate('location.hash = "#/resources"')
await sleep(1100)
await shot('08-dark-resources')

// 切回浅色
await evaluate('location.hash = "#/settings"')
await sleep(900)
await evaluate('document.querySelectorAll(".settings__tab")[1].click()')
await sleep(800)
await evaluate('document.querySelectorAll(".theme-card")[0].click()')
await sleep(1200)
record('可切回浅色模式', (await evaluate('(async () => (await window.api.settings.get()).themeMode)()')) === 'light', 'light')

/* ---------------------------- 存储 / 关于分栏 ---------------------------- */
await evaluate('document.querySelectorAll(".settings__tab")[2].click()')
await sleep(900)
await shot('09-settings-storage')
await evaluate('document.querySelectorAll(".settings__tab")[3].click()')
await sleep(1200)
const aboutText = await evaluate('document.querySelector(".settings__content")?.innerText?.slice(0, 300) ?? ""')
record('关于页显示应用信息', aboutText.includes('穷哥们的工具箱'), aboutText.slice(0, 60))
await shot('10-settings-about')

/* --------------------------- 系统信息 / Python --------------------------- */
const sys = await evaluate(`(async () => {
  const info = await window.api.system.info()
  const py = await window.api.python.status()
  const runtime = await window.api.python.runtime()
  return { appName: info.appName, electron: info.electron, platform: info.platform, memory: info.totalMemory,
           userDataPath: info.userDataPath, pythonReady: py.ready, pythonVersion: py.version,
           runtimeVersion: runtime.version, runtimeRunning: runtime.running, cache: await window.api.system.cacheSize() }
})()`)
record('system.info 返回完整环境信息', Boolean(sys.appName) && Boolean(sys.electron) && sys.platform === 'win32', sys)
record(
  'python.status 结构完整（未安装运行时也不抛错）',
  typeof sys.pythonReady === 'boolean' && (!sys.pythonReady || Boolean(sys.pythonVersion)),
  { ready: sys.pythonReady, version: sys.pythonVersion }
)
record(
  'python.runtime 报出版本（装了运行时才有）',
  !sys.pythonReady || Boolean(sys.runtimeVersion),
  { runtimeVersion: sys.runtimeVersion, running: sys.runtimeRunning }
)

/* ------------------------------ 弹窗 / 侧栏 ------------------------------ */
await evaluate('location.hash = "#/resources"')
await sleep(1000)
await evaluate(`[...document.querySelectorAll("button")].find(b => b.innerText.includes("新建资源"))?.click()`)
await sleep(900)
record('点击「新建资源」打开弹窗', (await evaluate('Boolean(document.querySelector(".el-dialog"))')) === true, 'open')
await shot('11-resource-dialog')
await evaluate('document.querySelector(".el-dialog__headerbtn")?.click()')
await sleep(800)
const dialogVisible = await evaluate(`(() => {
  const el = document.querySelector(".el-dialog")
  if (!el) return false
  const wrap = el.closest(".el-overlay, .el-overlay-dialog")
  return Boolean(el.offsetParent) && (!wrap || getComputedStyle(wrap).display !== "none")
})()`)
record('弹窗可关闭', dialogVisible === false, dialogVisible)

const beforeWidth = await evaluate('getComputedStyle(document.querySelector(".sidebar")).width')
await evaluate('document.querySelector(".header__left .icon-btn")?.click()')
await sleep(800)
const afterWidth = await evaluate('getComputedStyle(document.querySelector(".sidebar")).width')
record('侧栏可折叠', beforeWidth !== afterWidth, { beforeWidth, afterWidth })
await shot('12-sidebar-collapsed')
await evaluate('document.querySelector(".header__left .icon-btn")?.click()')
await sleep(500)

/* ------------------------------ 路由 / 窗口 ------------------------------ */
const wm = await evaluate(`(async () => {
  const before = await window.api.window.isMaximized()
  window.api.window.toggleMaximize()
  await new Promise(r => setTimeout(r, 500))
  const after = await window.api.window.isMaximized()
  window.api.window.toggleMaximize()
  return { before, after }
})()`)
record('窗口最大化可切换', wm.before !== wm.after, wm)

await evaluate('location.hash = "#/nope"')
await sleep(800)
record('未知路由落到 404 页', await evaluate('document.body.innerText.includes("404") || document.body.innerText.includes("不存在")'), '404')
await shot('13-not-found')
await evaluate('location.hash = "#/dashboard"')
await sleep(600)

record('渲染层无未捕获异常 / console.error', consoleErrors.length === 0, consoleErrors.slice(0, 5))

/* --------------------------------- 汇总 --------------------------------- */
const failed = checks.filter((c) => !c.pass)
console.log(
  JSON.stringify(
    {
      screens: fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.png')).map((f) => path.join(OUT_DIR, f).replace(/\\/g, '/')),
      passed: checks.length - failed.length,
      failed,
      checks
    },
    null,
    2
  )
)
ws.close()
process.exit(failed.length === 0 ? 0 : 2)
