# legacy-audit · 工具安装脚本
# 用途：换机器 / 他人 clone 后，恢复 tools/ 下不进 git 的二进制（约 80MB）
# 用法：pwsh -NoProfile -File scripts\install-tools.ps1
$ErrorActionPreference = 'Stop'

$SkillRoot = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $SkillRoot 'tools'
$AliyunPyPI = 'https://mirrors.aliyun.com/pypi'
$AliyunMaven = 'https://maven.aliyun.com/repository/public'

Write-Host "== legacy-audit 工具安装 ==" -ForegroundColor Cyan
Write-Host "skill: $SkillRoot"
Write-Host "tools: $Tools"
Write-Host ""

New-Item -ItemType Directory -Force -Path $Tools | Out-Null

# ---------- 1. SpotBugs ----------
$sbDir = Join-Path $Tools 'sb'
$sbExe = Join-Path $sbDir 'spotbugs-4.8.3\lib\spotbugs.jar'
if (Test-Path $sbExe) {
    Write-Host "[跳过] SpotBugs 已存在" -ForegroundColor DarkGray
} else {
    Write-Host "[下载] SpotBugs 4.8.3 (46MB)..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $sbDir | Out-Null
    $tgz = Join-Path $sbDir 'spotbugs.tgz'
    Invoke-WebRequest -Uri "$AliyunMaven/com/github/spotbugs/spotbugs/4.8.3/spotbugs-4.8.3.tgz" -OutFile $tgz -UseBasicParsing
    tar -xzf $tgz -C $sbDir
    Remove-Item $tgz -Force
    Write-Host "[完成] SpotBugs" -ForegroundColor Green
}

# ---------- 2. ruff ----------
$ruffDir = Join-Path $Tools 'ruffbin'
$ruffExe = Join-Path $ruffDir 'ruff-0.9.9.data\scripts\ruff.exe'
if (Test-Path $ruffExe) {
    Write-Host "[跳过] ruff 已存在" -ForegroundColor DarkGray
} else {
    Write-Host "[下载] ruff 0.9.9 (33MB)..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $ruffDir | Out-Null
    # 从 PyPI simple index 解析 wheel 直链
    $idx = Invoke-WebRequest -Uri "$AliyunPyPI/simple/ruff/" -UseBasicParsing
    $link = ($idx.Links | Where-Object { $_.href -match 'ruff-0\.9\.9-py3-none-win_amd64\.whl' } | Select-Object -First 1)
    if (-not $link) { throw "未找到 ruff 0.9.9 win_amd64 wheel，请手动下载" }
    $url = $link.href
    if ($url -notmatch '^https?://') {
        $url = ($AliyunPyPI + '/simple/ruff/' + $url) -replace '/simple/ruff/\.\./', '/pypi/'
    }
    $whl = Join-Path $ruffDir 'ruff.whl'
    Invoke-WebRequest -Uri $url -OutFile $whl -UseBasicParsing
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($whl, $ruffDir)
    Remove-Item $whl -Force
    Write-Host "[完成] ruff" -ForegroundColor Green
}

# ---------- 3. radon ----------
$pyDir = Join-Path $Tools 'pytools'
if (Test-Path (Join-Path $pyDir 'radon')) {
    Write-Host "[跳过] radon 已存在" -ForegroundColor DarkGray
} else {
    Write-Host "[安装] radon 6.0.1..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $pyDir | Out-Null
    python -m pip install --index-url "$AliyunPyPI/simple/" --target $pyDir radon==6.0.1
    Write-Host "[完成] radon" -ForegroundColor Green
}

# ---------- 4. jscpd 工作目录 ----------
$jscpdDir = Join-Path $Tools 'jscpd'
if (-not (Test-Path $jscpdDir)) {
    New-Item -ItemType Directory -Force -Path $jscpdDir | Out-Null
    Write-Host "[完成] jscpd 工作目录（包由 npx 即时拉取）" -ForegroundColor Green
} else {
    Write-Host "[跳过] jscpd 目录已存在" -ForegroundColor DarkGray
}

# ---------- 5. 校验 ----------
Write-Host ""
Write-Host "== 校验 ==" -ForegroundColor Cyan
$ok = $true
if (Test-Path $sbExe) {
    $v = & java -jar $sbExe -version 2>&1 | Select-Object -First 1
    Write-Host "  SpotBugs: $v" -ForegroundColor Green
} else { Write-Host "  SpotBugs: 缺失" -ForegroundColor Red; $ok = $false }

if (Test-Path $ruffExe) {
    $v = & $ruffExe --version
    Write-Host "  ruff: $v" -ForegroundColor Green
} else { Write-Host "  ruff: 缺失" -ForegroundColor Red; $ok = $false }

$radonOk = python -c "import sys; sys.path.insert(0, r'$pyDir'); import radon; print('radon', radon.__version__ if hasattr(radon,'__version__') else 'ok')" 2>&1
if ($LASTEXITCODE -eq 0) { Write-Host "  $radonOk" -ForegroundColor Green }
else { Write-Host "  radon: 缺失" -ForegroundColor Red; $ok = $false }

foreach ($c in @('mvn', 'npx', 'node', 'java')) {
    if (Get-Command $c -ErrorAction SilentlyContinue) { Write-Host "  $c: OK" -ForegroundColor Green }
    else { Write-Host "  $c: 未安装（必需）" -ForegroundColor Red; $ok = $false }
}
if (Get-Command cargo -ErrorAction SilentlyContinue) { Write-Host "  cargo: OK（Rust 可选）" -ForegroundColor Green }
else { Write-Host "  cargo: 未安装（仅 Rust 仓需要）" -ForegroundColor DarkYellow }

Write-Host ""
if ($ok) { Write-Host "全部就绪。" -ForegroundColor Green; exit 0 }
else { Write-Host "有缺失项，请按上面红色提示补齐。" -ForegroundColor Red; exit 1 }
