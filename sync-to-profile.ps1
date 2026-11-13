# sync-to-profile.ps1 — 把本仓库源码同步到 DSH profile 加载的副本
#
# 为什么需要它：
#   profile\package.json 里写的是 file:...\projects\dsh-long-memory，
#   但安装时是【复制】而不是建链接。所以改了这个目录的代码，
#   宿主加载的 node_modules\dsh-long-memory 仍然是旧的，
#   重启也没用（why 字段里的权重还是老值）。
#
# 用法：
#   pwsh -File sync-to-profile.ps1
#   然后【完全退出 DSH 再重新打开】。
#
# 参数：
#   -CheckOnly  只比对，不写入

[CmdletBinding()]
param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-long-memory'

Write-Host ''
Write-Host "  源目录: $src"
Write-Host "  目标  : $dst"
Write-Host ''

if (-not (Test-Path $dst)) {
    Write-Host '  [错误] 目标目录不存在，插件可能没装到这个 profile。' -ForegroundColor Red
    Write-Host "         检查 $(Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json') 里有没有 dsh-long-memory 依赖。"
    exit 1
}

# --- 需要同步的路径 ---
$files = @('package.json', 'cordis.patch.yml', 'dsh.plugin.json')
$dirs = @('src', 'scripts')

# --- 先算差异，让用户知道要动什么 ---
function Get-Diff {
    $rows = @()
    foreach ($d in $dirs) {
        $s = Join-Path $src $d
        if (-not (Test-Path $s)) { continue }
        foreach ($f in Get-ChildItem $s -Recurse -File) {
            $rel = $f.FullName.Substring($src.Length + 1)
            $t = Join-Path $dst $rel
            if (-not (Test-Path $t)) {
                $rows += [pscustomobject]@{ 文件 = $rel; 状态 = '新增' }
            }
            elseif ((Get-FileHash $f.FullName).Hash -ne (Get-FileHash $t).Hash) {
                $rows += [pscustomobject]@{ 文件 = $rel; 状态 = '内容不同' }
            }
        }
    }
    foreach ($f in $files) {
        $s = Join-Path $src $f
        if (-not (Test-Path $s)) { continue }
        $t = Join-Path $dst $f
        if (-not (Test-Path $t)) { $rows += [pscustomobject]@{ 文件 = $f; 状态 = '新增' } }
        elseif ((Get-FileHash $s).Hash -ne (Get-FileHash $t).Hash) {
            $rows += [pscustomobject]@{ 文件 = $f; 状态 = '内容不同' }
        }
    }
    return $rows
}

$diff = @(Get-Diff)
Write-Host "  === 差异（$($diff.Count) 个文件）==="
if ($diff.Count -eq 0) {
    Write-Host '  两侧完全一致，无需同步。' -ForegroundColor Green
    exit 0
}
$diff | Format-Table -AutoSize | Out-String | Write-Host

if ($CheckOnly) {
    Write-Host '  -CheckOnly：只比对，未写入。' -ForegroundColor Yellow
    exit 0
}

# --- 备份目标侧 ---
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $src ".sync-backup\$stamp"
New-Item -ItemType Directory -Force -Path $bak | Out-Null
foreach ($d in $dirs) {
    $t = Join-Path $dst $d
    if (Test-Path $t) { Copy-Item $t (Join-Path $bak $d) -Recurse -Force }
}
foreach ($f in $files) {
    $t = Join-Path $dst $f
    if (Test-Path $t) { Copy-Item $t (Join-Path $bak $f) -Force }
}
Write-Host "  [1/3] 旧副本已备份到 .sync-backup\$stamp"

# --- 同步 ---
foreach ($d in $dirs) {
    $s = Join-Path $src $d
    if (-not (Test-Path $s)) { continue }
    $t = Join-Path $dst $d
    New-Item -ItemType Directory -Force -Path $t | Out-Null
    Copy-Item (Join-Path $s '*') $t -Recurse -Force
}
Write-Host '  [2/3] src / scripts 已同步'

foreach ($f in $files) {
    $s = Join-Path $src $f
    if (-not (Test-Path $s)) { continue }
    $t = Join-Path $dst $f
    if (-not (Test-Path $t)) { Copy-Item $s $t -Force; continue }
    # 硬链接检查：如果两侧是同一个物理文件，覆盖会报"无法用自身覆盖项"，直接跳过
    $isHardLink = $false
    try {
        $links = (cmd /c fsutil hardlink list "$s" 2>$null) -split "`r?`n" | Where-Object { $_ }
        if ($links.Count -gt 1) { $isHardLink = $true }
    } catch { }
    if ($isHardLink) {
        Write-Host "    $f 是硬链接，两侧本就是同一份，跳过"
        continue
    }
    Copy-Item $s $t -Force
}
Write-Host '  [3/3] 顶层配置已同步'

# --- 校验 ---
Write-Host ''
Write-Host '  === 校验 ==='
$coreDst = Join-Path $dst 'src\core.js'
foreach ($key in 'wRetention:', 'wImportance:', 'wRelevance:', 'minTermCoverage:') {
    $line = Select-String -Path $coreDst -Pattern $key | Select-Object -First 1
    if ($line) { Write-Host "    副本 $($line.Line.Trim())" }
}
$left = @(Get-Diff)
if ($left.Count -eq 0) {
    Write-Host '    两侧哈希一致 ✅' -ForegroundColor Green
} else {
    Write-Host "    仍有 $($left.Count) 个文件不一致 ❌" -ForegroundColor Red
}

# --- 语法检查 ---
foreach ($js in 'src\core.js', 'src\index.js') {
    $p = Join-Path $dst $js
    if (Test-Path $p) {
        node --check $p 2>$null
        if ($LASTEXITCODE -eq 0) { Write-Host "    $js 语法 OK" -ForegroundColor Green }
        else { Write-Host "    $js 语法错误 ❌" -ForegroundColor Red }
    }
}

Write-Host ''
Write-Host '  [完成] 现在必须【完全退出 DSH 再重新打开】，同步才会生效。' -ForegroundColor Cyan
Write-Host ''
