# 给项目内置 Python 运行时安装后端依赖（FastAPI 等）
# 用法：npm run setup:backend
#       powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-backend-deps.ps1
# 可选：-IndexUrl <镜像> -Force（强制重装）

param(
  [string]$IndexUrl = 'https://pypi.tuna.tsinghua.edu.cn/simple',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$python = Join-Path $root 'runtime\python\python.exe'
if (-not (Test-Path $python)) {
  throw "未找到内置 Python 运行时：$python`n请先执行 npm run setup:python"
}

$requirements = Join-Path $root 'runtime\backend\requirements.txt'
if (-not (Test-Path $requirements)) {
  throw "未找到依赖清单：$requirements"
}

$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$mirrors = @($IndexUrl, 'https://pypi.org/simple', 'https://mirrors.aliyun.com/pypi/simple') | Select-Object -Unique

$installed = $false
foreach ($mirror in $mirrors) {
  Write-Host "==> 安装后端依赖（源：$mirror）"
  $pipArgs = @('-m', 'pip', 'install', '--no-input', '--no-warn-script-location', '--index-url', $mirror, '-r', $requirements)
  if ($Force) { $pipArgs += '--upgrade' }
  & $python @pipArgs
  if ($LASTEXITCODE -eq 0) {
    $installed = $true
    break
  }
  Write-Host "    该源安装失败，换下一个"
}

if (-not $installed) {
  throw '依赖安装失败。请检查网络，或手动执行：runtime\python\python.exe -m pip install -r runtime\backend\requirements.txt'
}

Write-Host '==> 校验导入'
& $python -c "import fastapi, uvicorn, sqlalchemy, pydantic_settings; print('fastapi', fastapi.__version__, '| uvicorn', uvicorn.__version__, '| sqlalchemy', sqlalchemy.__version__, '| pydantic-settings', pydantic_settings.__version__)"
if ($LASTEXITCODE -ne 0) { throw '依赖导入失败' }

Write-Host '==> 完成。重新启动应用即可使用 FastAPI 后端'
