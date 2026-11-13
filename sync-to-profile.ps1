# sync-to-profile.ps1 — 把本仓库源码同步到 DSH profile 加载的插件副本
#
# 为什么需要它：
#   profile 的 package.json 里写 `dsh-long-memory: file:<本仓库路径>`，
#   但安装时是【复制】而不是建链接。所以改了这个目录的代码，
#   宿主加载的 node_modules/dsh-long-memory 仍然是旧的，重启也没用。
#
# 用法：
#   pwsh -File sync-to-profile.ps1                    # 自动找 profile
#   pwsh -File sync-to-profile.ps1 -Profile desktop   # 指定 profile 名
#   pwsh -File sync-to-profile.ps1 -CheckOnly         # 只比对，不写入
#   pwsh -File sync-to-profile.ps1 -DshHome D:\mytsh  # 指定 DSH_HOME
#
# 兼容性：Windows PowerShell 5.1 与 PowerShell 7+ 都能跑（不用 ?? / 三元 / -Parallel）。

[CmdletBinding()]
param(
    [string]$Profile,
    [string]$DshHome,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$pluginName = 'dsh-long-memory'

# --- 1. 定位 DSH_HOME ---
# 优先级：参数 > 环境变量 > 默认 ~/.dsh
function Resolve-DshHome {
    param([string]$Explicit, [string]$Root)
    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "指定的 DSH_HOME 不存在：$Explicit" }
        return (Resolve-Path $Explicit).Path
    }
    if ($env:DSH_HOME) {
        if (Test-Path $env:DSH_HOME) { return (Resolve-Path $env:DSH_HOME).Path }
        Write-Host "  [警告] DSH_HOME 指向的路径不存在，改用默认值" -ForegroundColor Yellow
    }
    $def = Join-Path $Root '.dsh'
    if (Test-Path $def) { return (Resolve-Path $def).Path }
    return $null
}

$homePath = Resolve-DshHome -Explicit $DshHome -Root $env:USERPROFILE
if (-not $homePath) {
    Write-Host ''
    Write-Host "  [错误] 找不到 DSH_HOME（默认位置：$env:USERPROFILE\.dsh）" -ForegroundColor Red
    Write-Host '         用 -DshHome 指定，例如：-DshHome D:\my-dsh-home'
    exit 1
}

# --- 2. 定位 profile ---
$profilesDir = Join-Path $homePath 'profiles'
if (-not (Test-Path $profilesDir)) {
    Write-Host "  [错误] 没有 profiles 目录：$profilesDir" -ForegroundColor Red
    exit 1
}

function Test-ProfileHasPlugin {
    param([string]$ProfilePath)
    $pj = Join-Path $ProfilePath 'package.json'
    if (-not (Test-Path $pj)) { return $false }
    try { $json = Get-Content $pj -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $false }
    if (-not $json.dependencies) { return $false }
    $dep = $json.dependencies.PSObject.Properties[$pluginName]
    return [bool]$dep
}

$candidates = @()
if ($Profile) {
    $p = Join-Path $profilesDir $Profile
    if (-not (Test-Path $p)) {
        Write-Host "  [错误] profile 不存在：$p" -ForegroundColor Red
        exit 1
    }
    $candidates = @($p)
} else {
    # 自动挑：所有装了本插件的 profile
    $all = Get-ChildItem $profilesDir -Directory -ErrorAction SilentlyContinue
    foreach ($d in $all) { if (Test-ProfileHasPlugin -ProfilePath $d.FullName) { $candidates += $d.FullName } }
}

if ($candidates.Count -eq 0) {
    Write-Host ''
    Write-Host "  [错误] 没有任何 profile 装了 $pluginName" -ForegroundColor Red
    Write-Host "         先安装插件，或检查 profile 的 package.json 里有没有这条依赖。"
    Write-Host "         现有 profile："
    Get-ChildItem $profilesDir -Directory | ForEach-Object { Write-Host "           - $($_.Name)" }
    exit 1
}

if ($candidates.Count -gt 1) {
    Write-Host ''
    Write-Host "  [提示] 多个 profile 都装了 $pluginName，用 -Profile 指定一个：" -ForegroundColor Yellow
    foreach ($c in $candidates) { Write-Host "           - $(Split-Path $c -Leaf)" }
    exit 1
}

$profilePath = $candidates[0]
$profileName = Split-Path $profilePath -Leaf
$dst = Join-Path $profilePath "node_modules\$pluginName"
$src = $PSScriptRoot

Write-Host ''
Write-Host "  DSH_HOME : $homePath"
Write-Host "  profile  : $profileName"
Write-Host "  源目录   : $src"
Write-Host "  目标     : $dst"
Write-Host ''

if (-not (Test-Path $dst)) {
    Write-Host "  [错误] 目标目录不存在：$dst" -ForegroundColor Red
    Write-Host "         插件记在 package.json 里，但 node_modules 下没有实体。"
    Write-Host "         重新装一次插件，或手动把它放进这个路径。"
    exit 1
}

# --- 3.5 来源校验：确认本仓库就是 profile 登记的那个来源 ---
# 防止在别的仓库里误运行，把它的 src 覆盖到本机已装插件上。
function Get-ProfileDepSpec {
    param([string]$ProfilePath)
    $pj = Join-Path $ProfilePath 'package.json'
    try { $json = Get-Content $pj -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
    if (-not $json.dependencies) { return $null }
    $dep = $json.dependencies.PSObject.Properties[$pluginName]
    if (-not $dep) { return $null }
    return [string]$dep.Value
}

$spec = Get-ProfileDepSpec -ProfilePath $profilePath
if ($spec -and $spec -like 'file:*') {
    $declared = $spec.Substring(5).Trim()
    # 归一化后再比，避免斜杠方向 / 大小写差异造成误报
    $normDeclared = $declared.Replace('/', '\').TrimEnd('\')
    $normSelf = $src.Replace('/', '\').TrimEnd('\')
    if ($normDeclared -ne $normSelf) {
        Write-Host '  [错误] 这个目录不是 profile 里登记的插件来源，拒绝同步。' -ForegroundColor Red
        Write-Host "         profile 登记：$declared"
        Write-Host "         当前仓库    ：$src"
        Write-Host '         如果你确实想覆盖，把本仓库挪到登记的那个路径，或改 profile 的依赖。'
        exit 1
    }
} elseif ($spec) {
    # 非 file: 形式（npm 包名），无法用路径比对，只提示不阻断
    Write-Host "  [提示] profile 里登记的是 $spec，不是本地路径，跳过来源校验。" -ForegroundColor Yellow
}

# --- 4. 判断目标是不是链接（链接就不需要同步）---
$dstItem = Get-Item $dst -Force
if ($dstItem.LinkType) {
    Write-Host "  目标是一个 $($dstItem.LinkType)，指向 $(@($dstItem.Target) -join ', ')" -ForegroundColor Green
    Write-Host '  改动会直接生效，无需同步。' -ForegroundColor Green
    exit 0
}

# --- 4. 算差异 ---
$files = @('package.json', 'cordis.patch.yml', 'dsh.plugin.json')
$dirs  = @('src', 'scripts')

function Get-FileState {
    param([string]$RelPath)
    $s = Join-Path $src $RelPath
    $t = Join-Path $dst $RelPath
    if (-not (Test-Path $t)) { return '新增' }
    try {
        $hs = (Get-FileHash $s -Algorithm SHA256).Hash
        $ht = (Get-FileHash $t -Algorithm SHA256).Hash
        if ($hs -ne $ht) { return '内容不同' }
    } catch {
        return '哈希失败'
    }
    return '一致'
}

function Get-IsHardLink {
    param([string]$Path)
    # Windows PowerShell 5.1 没有 fsutil 之外的干净办法，用 fsutil 输出行数判断
    try {
        $out = & fsutil hardlink list "$Path" 2>$null
        if (-not $out) { return $false }
        return (@($out).Count -gt 1)
    } catch {
        return $false
    }
}

$diff = @()
foreach ($d in $dirs) {
    $sd = Join-Path $src $d
    if (-not (Test-Path $sd)) { continue }
    foreach ($f in Get-ChildItem $sd -Recurse -File) {
        $rel = $f.FullName.Substring($src.Length + 1)
        $state = Get-FileState -RelPath $rel
        if ($state -ne '一致') { $diff += New-Object PSObject -Property @{ 文件 = $rel; 状态 = $state } }
    }
}
foreach ($f in $files) {
    if (-not (Test-Path (Join-Path $src $f))) { continue }
    $state = Get-FileState -RelPath $f
    if ($state -ne '一致') { $diff += New-Object PSObject -Property @{ 文件 = $f; 状态 = $state } }
}

Write-Host "  === 差异（$($diff.Count) 个文件）==="
if ($diff.Count -eq 0) {
    Write-Host '  两侧完全一致，无需同步。' -ForegroundColor Green
    exit 0
}
$diff | Sort-Object 文件 | Format-Table -AutoSize | Out-String | Write-Host

if ($CheckOnly) {
    Write-Host '  -CheckOnly：只比对，未写入。' -ForegroundColor Yellow
    exit 0
}

# --- 5. 备份目标侧 ---
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $src ('.sync-backup\' + $stamp)
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

# --- 6. 同步 ---
foreach ($d in $dirs) {
    $sd = Join-Path $src $d
    if (-not (Test-Path $sd)) { continue }
    $td = Join-Path $dst $d
    New-Item -ItemType Directory -Force -Path $td | Out-Null
    Copy-Item (Join-Path $sd '*') $td -Recurse -Force
}
Write-Host '  [2/3] src / scripts 已同步'

foreach ($f in $files) {
    $s = Join-Path $src $f
    if (-not (Test-Path $s)) { continue }
    $t = Join-Path $dst $f
    if (-not (Test-Path $t)) {
        Copy-Item $s $t -Force
        continue
    }
    # 硬链接保护：两侧若指向同一份物理数据，覆盖会报"无法用自身覆盖项"
    if (Get-IsHardLink -Path $s) {
        Write-Host "    $f 是硬链接，两侧本就是同一份，跳过"
        continue
    }
    Copy-Item $s $t -Force
}
Write-Host '  [3/3] 顶层配置已同步'

# --- 7. 校验 ---
Write-Host ''
Write-Host '  === 校验 ==='
$coreDst = Join-Path $dst 'src\core.js'
if (Test-Path $coreDst) {
    foreach ($key in 'wRetention:', 'wImportance:', 'wRelevance:', 'minTermCoverage:') {
        $line = Select-String -Path $coreDst -Pattern $key | Select-Object -First 1
        if ($line) { Write-Host "    副本 $($line.Line.Trim())" }
    }
}

$left = 0
foreach ($d in $dirs) {
    $sd = Join-Path $src $d
    if (-not (Test-Path $sd)) { continue }
    foreach ($f in Get-ChildItem $sd -Recurse -File) {
        $rel = $f.FullName.Substring($src.Length + 1)
        if ((Get-FileState -RelPath $rel) -ne '一致') { $left++ }
    }
}
foreach ($f in $files) {
    if (-not (Test-Path (Join-Path $src $f))) { continue }
    if ((Get-FileState -RelPath $f) -ne '一致') { $left++ }
}

if ($left -eq 0) {
    Write-Host '    两侧哈希一致' -ForegroundColor Green
} else {
    Write-Host "    仍有 $left 个文件不一致" -ForegroundColor Red
}

# --- 8. 语法检查（有 node 才做）---
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    foreach ($js in 'src\core.js', 'src\index.js') {
        $p = Join-Path $dst $js
        if (-not (Test-Path $p)) { continue }
        & node --check $p 2>$null
        if ($LASTEXITCODE -eq 0) { Write-Host "    $js 语法 OK" -ForegroundColor Green }
        else { Write-Host "    $js 语法错误" -ForegroundColor Red }
    }
} else {
    Write-Host '    （没找到 node，跳过语法检查）' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '  [完成] 现在必须【完全退出 DSH 再重新打开】，同步才会生效。' -ForegroundColor Cyan
Write-Host ''
