$ErrorActionPreference = "Stop"
$ProjectName = "h2-hot2"
$DateStr = Get-Date -Format "yyyyMMdd-HHmmss"
$OutputFile = "${ProjectName}-deploy-${DateStr}.zip"
$ScriptDir = $PSScriptRoot
$ProjectRoot = (Get-Item $ScriptDir).Parent.FullName
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "h2-hot2-zip-$([Guid]::NewGuid().ToString('N'))"

try {
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Deploy Packer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Project: $ProjectRoot" -ForegroundColor Gray
Write-Host "Output:  $ScriptDir\$OutputFile" -ForegroundColor Gray
Write-Host ""

# Create temp dir for filtered copy
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

# 排除规则
# 分两类：
#   1) 目录/文件名（不含 *）：按路径段匹配，命中整段即排除。
#      例：".next" 命中 .next\BUILD_ID、src\.next\x；"node_modules" 同理。
#   2) glob（含 *）：仅对文件名(leaf)做 -like 匹配，避免误伤目录。
#      例："*.pem"、"*.db.bak.*"
# 含方括号路径（如 src\app\api\sources\[id]\route.ts）全程走字符串操作 + .NET API，
# 不经过 PowerShell 通配符，保证 [id] 等路径被原样复制与压缩。
$ExcludePatterns = @(
    "node_modules",
    ".next",
    ".pnp",
    ".pnp.*",
    ".yarn",
    "dist",
    ".cache",
    ".turbo",
    "coverage",
    ".git",
    ".agents",
    ".codex",
    ".claude",
    ".z-ai-config",
    "design-previews",
    ".DS_Store",
    "nul",
    "next-env.d.ts",
    "worklog.md",
    # 根目录 Markdown 由下方路径级规则排除；bat/ 内部署文档继续保留
    "config.toml",
    # bat/ 部署文档保留
    "docs",
    "skills",
    "tests",
    "vitest.config.ts",
    "sources-check.json",
    "sources.json",
    ".env",
    ".env.*",
    "db",
    "*.pem",
    "*.log",
    "*.tsbuildinfo",
    "*.db",
    "*.db-journal",
    "*.db-wal",
    "*.db-shm",
    "*.db.bak.*",
    # 仅根目录和 bat/ 下的旧部署 zip 由下方路径级规则排除
    # scripts/ 整体不再排除;只按文件名精确排除一次性 dev 脚本,
    # 保留 db-baseline.ts(部署存量库首次切换时必需)。
    "scripts/backfill-prompt-defaults.ts",
    "scripts/cleanup-legacy-settings.ts",
    # bat/ 目录里只排除打包工具脚本，部署/Nginx 文档继续随包发布
    "bat/run.bat",
    "bat/pack-deploy.ps1",
    "bat/启动.vbs",
    "bat/本地一键初始化.bat",
    "bat/local-init.ps1"
)

function Test-ShouldExclude($relativePath, $patterns) {
    # 统一分隔符为 \
    $p = $relativePath -replace '/', '\'
    # 拆成路径段数组，便于按目录名匹配
    $segments = $p -split '\\'
    $leaf = $segments[-1]
    if ($segments.Count -eq 1 -and $leaf -like '*.md') { return $true }
    if (($segments.Count -eq 1 -or $segments[0].Equals('bat', [System.StringComparison]::OrdinalIgnoreCase)) -and $leaf -like '*.zip') { return $true }
    foreach ($exc in $patterns) {
        $e = $exc -replace '/', '\'
        if ($e.Contains('*')) {
            if ($e.Contains('\')) {
                # 含路径分隔符的 glob：对完整相对路径做 -like
                if ($p -like $e) { return $true }
            } else {
                # 纯文件名 glob，如 "*.pem"：仅匹配 leaf，避免命中目录
                if ($leaf -like $e) { return $true }
            }
            continue
        }
        if ($e.Contains('\')) {
            # 含路径分隔符的精确路径，如 "bat/run.bat"：相等或作为前缀
            if ($p -eq $e) { return $true }
            if ($p.StartsWith($e + '\')) { return $true }
            continue
        }
        # 普通名：若任一路径段等于该名，则该路径落在该目录下（或是该文件），排除
        if ($segments -contains $e) { return $true }
    }
    return $false
}

Write-Host "Copying files (excluding patterns)..." -ForegroundColor Yellow

# 关键：用 .NET File.Copy 而非 Copy-Item。
# Copy-Item 的 -Path/-Destination 在含 [ ] 的路径下会被 PowerShell 当通配符解析，
# 导致 src\app\api\sources\[id]\route.ts 这类文件在复制时丢失实体，只留空目录。
# File.Copy 接收字面量字符串路径，不做通配符展开。
$srcLen = $ProjectRoot.Length + 1
$copied = 0
$skipped = 0
Get-ChildItem -Path $ProjectRoot -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    $relativePath = $_.FullName.Substring($srcLen)
    if (Test-ShouldExclude $relativePath $ExcludePatterns) { $skipped++; return }

    $destPath = Join-Path $TempDir $relativePath
    $destDir = Split-Path $destPath -Parent
    if (-not (Test-Path -LiteralPath $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    [System.IO.File]::Copy($_.FullName, $destPath, $true)
    $copied++
}
Write-Host "  copied: $copied   skipped: $skipped" -ForegroundColor Gray

$RequiredReleaseFiles = @(
    "package.json",
    "package-lock.json",
    "scripts\init-production.sh"
)
foreach ($requiredFile in $RequiredReleaseFiles) {
    $requiredPath = Join-Path $TempDir $requiredFile
    if (-not [System.IO.File]::Exists($requiredPath)) {
        throw "部署包缺少必要文件：$requiredFile"
    }
}

Write-Host "Zipping..." -ForegroundColor White

$OutputPath = Join-Path $ScriptDir $OutputFile
if (Test-Path $OutputPath) {
    Remove-Item $OutputPath -Force
}

# 用 .NET ZipFile.CreateFromDirectory 压缩整个 temp 目录：
# 它按文件系统枚举压缩，不经 PowerShell 通配符，含 [ ] 的路径原样压入 zip。
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($TempDir, $OutputPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)

# Back to project root
Set-Location $ProjectRoot

$Size = (Get-Item $OutputPath).Length
$SizeStr = if ($Size -gt 1GB) { "{0:N2} GB" -f ($Size / 1GB) } elseif ($Size -gt 1MB) { "{0:N2} MB" -f ($Size / 1MB) } else { "{0:N2} KB" -f ($Size / 1KB) }

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Done!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  File: $OutputFile" -ForegroundColor White
Write-Host "  Size: $SizeStr" -ForegroundColor White
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Deploy Steps" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. 将 ZIP 上传到 /tmp 等应用目录之外的位置。" -ForegroundColor Yellow
Write-Host "  2. 全新服务器：正确解压并同步到项目根目录后执行 bash scripts/init-production.sh。" -ForegroundColor Yellow
Write-Host "  3. 日常更新默认由 GitHub Actions 自动完成，无需手工上传 ZIP。" -ForegroundColor Yellow
Write-Host "     手工更新时先停止 h2-hot2 并备份数据库，再用 rsync --delete 收敛同步。" -ForegroundColor Yellow
Write-Host "     不要直接在应用目录执行 unzip -o，避免已删除的旧代码残留。" -ForegroundColor Red
Write-Host "  4. 顺序执行 migrate:deploy -> generate -> optimize -> build，再以单实例启动 PM2。" -ForegroundColor Yellow
Write-Host "  5. 已有数据库首次跨过 20260718230000 migration 时，自动部署会检测旧公开快照并重建；手工 rsync 更新需在迁移后执行 db:rebuild-public。" -ForegroundColor Yellow
Write-Host "  6. 普通应用更新不清空全局 Nginx 缓存，也不需要 reload Nginx。" -ForegroundColor Yellow
Write-Host ""
Write-Host "  完整可复制命令: bat/部署和更新方法.txt" -ForegroundColor Gray
Write-Host ""

Start-Process explorer.exe $ScriptDir

Write-Host "This window will close in 15 seconds..." -ForegroundColor Gray
Start-Sleep -Seconds 15
}
finally {
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
