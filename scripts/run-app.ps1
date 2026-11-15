# 以"开发态可运行"的方式启动应用（构建产物 + --no-sandbox）
# 用法：
#   npm run app                     普通启动
#   npm run app:debug               带 --remote-debugging-port=9355 启动（配合 npm run smoke）
#   powershell -File scripts/run-app.ps1 -DebugPort 9355

param(
  [int]$DebugPort = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 某些受限环境（CI / 沙箱）无法创建沙箱进程，开发态统一关闭沙箱
$env:ELECTRON_DISABLE_SANDBOX = '1'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 把临时目录指到项目内，避免系统 TEMP 权限问题
$tempDir = Join-Path $root '.tmp'
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$env:TEMP = $tempDir
$env:TMP = $tempDir

$userData = if ($env:APP_USER_DATA_DIR) { $env:APP_USER_DATA_DIR } else { Join-Path $root '.userdata' }
New-Item -ItemType Directory -Force -Path $userData | Out-Null

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  throw '未找到 electron，请先执行 npm install'
}

if (-not (Test-Path (Join-Path $root 'out\main\index.js'))) {
  Write-Host '==> 未发现构建产物，先执行 electron-vite build'
  & npx electron-vite build
}

$extra = @()
if ($DebugPort -gt 0) {
  $extra += "--remote-debugging-port=$DebugPort"
  Write-Host "==> 远程调试端口：$DebugPort（可执行 npm run smoke 做冒烟验收）"
}

Write-Host "==> 启动应用（userData: $userData）"
& $electron . --no-sandbox "--user-data-dir=$userData" @extra
