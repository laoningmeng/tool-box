# 下载并解压项目内置的 Python 运行时（python-build-standalone，免安装、可随包分发）
# 用法：npm run setup:python   或   powershell -File scripts/setup-python.ps1
# 可选参数：-Series 3.11（默认）指定 Python 小版本线

param(
  [string]$Series = '3.11'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$runtimeDir = Join-Path $root 'runtime\python'
$pythonExe = Join-Path $runtimeDir 'python.exe'
if (Test-Path $pythonExe) {
  Write-Host "==> 已存在 Python 运行时：$pythonExe"
  & $pythonExe --version
  exit 0
}

if (-not (Test-Path (Join-Path $root 'runtime'))) {
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'runtime') | Out-Null
}

# GitHub API 与下载走不同的镜像前缀（API 是 api.github.com，资产在 github.com/releases/download）
$apiMirrors = @(
  'https://gh-proxy.com/https://api.github.com',
  'https://ghfast.top/https://api.github.com',
  'https://api.github.com'
)
$downloadMirrors = @(
  'https://gh-proxy.com/https://github.com',
  'https://ghfast.top/https://github.com',
  'https://github.com'
)

Write-Host "==> 查询 python-build-standalone 最新 release（Python $Series）"
$release = $null
foreach ($mirror in $apiMirrors) {
  try {
    $candidate = Invoke-RestMethod -Uri "$mirror/repos/astral-sh/python-build-standalone/releases/latest" `
      -Headers @{ 'User-Agent' = 'app-setup' } -TimeoutSec 40
    # 只有拿到 release 对象（含 assets）才算成功
    if ($candidate -and $candidate.assets -and $candidate.assets.Count -gt 0) {
      $release = $candidate
      Write-Host "    命中：$mirror（tag $($candidate.tag_name)，$($candidate.assets.Count) 个资产）"
      break
    }
    Write-Host "    返回内容不含 assets：$mirror"
  } catch {
    Write-Host "    失败：$mirror -> $($_.Exception.Message)"
  }
}
if (-not $release) { throw '无法获取 release 信息，请检查网络或代理后重试' }

# 例：cpython-3.11.18+20261110-x86_64-pc-windows-msvc-install_only.tar.gz
# 排除 install_only_stripped 之类的变体
$asset = $release.assets | Where-Object {
  $_.name -like "cpython-$Series.*-x86_64-pc-windows-msvc-install_only.tar.gz"
} | Select-Object -First 1
if (-not $asset) {
  $available = ($release.assets | Where-Object { $_.name -like '*x86_64-pc-windows-msvc-install_only.tar.gz' } |
    ForEach-Object { $_.name }) -join ', '
  throw "未找到 Python $Series 的 Windows 安装包。当前可选：$available"
}

$tmp = Join-Path $root '.tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$archive = Join-Path $tmp $asset.name

Write-Host "==> 下载 $($asset.name)（约 $([math]::Round($asset.size / 1MB, 1)) MB）"
$downloaded = $false
foreach ($mirror in $downloadMirrors) {
  try {
    $url = "$mirror/astral-sh/python-build-standalone/releases/download/$($release.tag_name)/$($asset.name)"
    Write-Host "    GET $url"
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing -TimeoutSec 900
    if ((Test-Path $archive) -and (Get-Item $archive).Length -gt 10MB) {
      $downloaded = $true
      break
    }
    Write-Host "    文件过小，视为失败：$mirror"
  } catch {
    Write-Host "    失败：$mirror -> $($_.Exception.Message)"
  }
}
if (-not $downloaded) { throw '下载失败，请手动下载后解压到 runtime/python（保留 python/ 目录结构）' }

Write-Host '==> 解压'
$extract = Join-Path $tmp 'python-extract'
Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $extract | Out-Null
& tar -xzf $archive -C $extract
if ($LASTEXITCODE -ne 0) { throw '解压失败（需要 Windows 自带的 tar）' }

Remove-Item -Recurse -Force $runtimeDir -ErrorAction SilentlyContinue
Move-Item (Join-Path $extract 'python') $runtimeDir
Remove-Item -Recurse -Force $extract, $archive -ErrorAction SilentlyContinue

& $pythonExe --version
Write-Host '==> 完成。可执行 npm run app 启动应用（后端会使用该运行时）'
