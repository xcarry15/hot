$ErrorActionPreference = "Stop"
$ProjectName = "h2-hot2"
$DateStr = Get-Date -Format "yyyyMMdd-HHmmss"
$OutputFile = "${ProjectName}-deploy-${DateStr}.zip"
$ScriptDir = $PSScriptRoot
$ProjectRoot = (Get-Item $ScriptDir).Parent.FullName
$TempDir = Join-Path $env:TEMP "zip-temp-$PID"

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
    ".claude",
    ".z-ai-config",
    ".DS_Store",
    "nul",
    "next-env.d.ts",
    "worklog.md",
    "CHANGELOG.md",
    "README.md",
    "AGENTS.md",
    "DESIGN.md",
    "CLAUDE.md",
    # bat/ 部署文档保留
    "docs",
    "skills",
    "tests",
    "vitest.config.ts",
    "sources-check.json",
    "sources.json",
    ".env",
    "db",
    "*.pem",
    "*.log",
    "*.tsbuildinfo",
    "*.db",
    "*.db-journal",
    "*.db-wal",
    "*.db-shm",
    "*.db.bak.*",
    # scripts/ 整体不再排除;只按文件名精确排除一次性 dev 脚本,
    # 保留 db-baseline.ts(部署存量库首次切换时必需)。
    "scripts/backfill-prompt-defaults.ts",
    "scripts/cleanup-legacy-settings.ts",
    # bat/ 目录里只排除打包工具脚本与已生成的 zip，保留部署文档
    "bat/run.bat",
    "bat/pack-deploy.ps1",
    "bat/启动.vbs",
    "bat/*.zip"
)

function Test-ShouldExclude($relativePath, $patterns) {
    # 统一分隔符为 \
    $p = $relativePath -replace '/', '\'
    # 拆成路径段数组，便于按目录名匹配
    $segments = $p -split '\\'
    $leaf = $segments[-1]
    foreach ($exc in $patterns) {
        $e = $exc -replace '/', '\'
        if ($e.Contains('*')) {
            if ($e.Contains('\')) {
                # 含路径分隔符的 glob，如 "bat/*.zip"：对完整相对路径做 -like
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

# Cleanup
Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue

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
Write-Host "  0. Upload ZIP to server /www/wwwroot/hot.kfxz.cn/" -ForegroundColor Yellow
Write-Host "     cd /www/wwwroot/hot.kfxz.cn && unzip -o <zip>" -ForegroundColor Yellow
Write-Host "     npm install" -ForegroundColor Yellow
Write-Host ""
Write-Host "  写入 .env(首次部署时执行,以后保留 .env 不动):" -ForegroundColor Yellow
Write-Host "     echo 'DATABASE_URL=file:../db/custom.db' > .env" -ForegroundColor Yellow
Write-Host '     echo "API_TOKEN=$(openssl rand -hex 32)" >> .env' -ForegroundColor Yellow
Write-Host "     echo 'NEXT_PUBLIC_SITE_URL=https://hot.kfxz.cn' >> .env" -ForegroundColor Yellow
Write-Host "  NEXT_PUBLIC_SITE_URL 必须在 npm run build 前设置为正式域名。" -ForegroundColor Yellow
Write-Host "  部署后访问 /admin/login 输入 API_TOKEN，浏览器将使用 HttpOnly Cookie。" -ForegroundColor Yellow
Write-Host "  PM2 必须保持单实例，禁止 -i max / cluster / 多个 h2-hot2 实例。" -ForegroundColor Red
Write-Host ""
Write-Host "  --- 分支 A:新服务器(无 db/custom.db) ---" -ForegroundColor Green
Write-Host "  1A. mkdir -p db" -ForegroundColor Green
Write-Host "  2A. npm run db:migrate:deploy   # 空库应用全部 migration" -ForegroundColor Green
Write-Host "  3A. npm run db:generate" -ForegroundColor Green
Write-Host "  4A. npm run db:seed             # 写入默认数据源与默认设置" -ForegroundColor Green
Write-Host "  5A. npm run db:optimize         # 启用 WAL 并优化 SQLite" -ForegroundColor Green
Write-Host "  6A. npm run build" -ForegroundColor Green
Write-Host "  7A. pm2 start npm --name h2-hot2 -- start" -ForegroundColor Green
Write-Host "  8A. pm2 save" -ForegroundColor Green
Write-Host "  9A. rm -rf /www/server/nginx/proxy_cache_dir/* && nginx -s reload" -ForegroundColor Green
Write-Host ""
Write-Host "  --- 分支 B:存量服务器(已用 db push 维护的 db/custom.db)首次切换 ---" -ForegroundColor Magenta
Write-Host "  1B. pm2 stop h2-hot2" -ForegroundColor Magenta
Write-Host "  2B. cp db/custom.db db/custom.db.bak.`$(date +%Y%m%d-%H%M%S)   # 时间戳备份" -ForegroundColor Magenta
Write-Host "  3B. npm run db:migrate:baseline   # 漂移预检 + 标记 baseline;drift 则停止" -ForegroundColor Magenta
Write-Host "  4B. npm run db:migrate:deploy     # baseline 之后为空操作,但仍要跑以校验" -ForegroundColor Magenta
Write-Host "  5B. npm run db:generate" -ForegroundColor Magenta
Write-Host "  6B. npm run db:optimize           # 启用 WAL 并优化 SQLite" -ForegroundColor Magenta
Write-Host "  7B. npm run build" -ForegroundColor Magenta
Write-Host "  8B. pm2 start h2-hot2" -ForegroundColor Magenta
Write-Host "  9B. npm run db:migrate:status     # 验证 _prisma_migrations 状态" -ForegroundColor Magenta
Write-Host " 10B. rm -rf /www/server/nginx/proxy_cache_dir/* && nginx -s reload" -ForegroundColor Magenta
Write-Host "  严禁:存量库首次切换中不要执行 db:seed(会写入重复默认源/设置)," -ForegroundColor Red
Write-Host "       也不要先跑 db:migrate:deploy 再跑 baseline(会创建空 _prisma_migrations)。" -ForegroundColor Red
Write-Host ""
Write-Host "  --- 分支 C:存量服务器日常更新(已 baseline 过的库) ---" -ForegroundColor Cyan
Write-Host "  1C. pm2 stop h2-hot2" -ForegroundColor Cyan
Write-Host "  2C. npm run db:migrate:deploy     # 应用新 migration;无新 migration 时为空操作" -ForegroundColor Cyan
Write-Host "  3C. npm run db:generate" -ForegroundColor Cyan
Write-Host "  4C. npm run db:optimize           # 校验 WAL 并执行 PRAGMA optimize" -ForegroundColor Cyan
Write-Host "  5C. npm run build" -ForegroundColor Cyan
Write-Host "  6C. pm2 start h2-hot2" -ForegroundColor Cyan
Write-Host "  7C. rm -rf /www/server/nginx/proxy_cache_dir/* && nginx -s reload" -ForegroundColor Cyan
Write-Host "  8C. 可选: npm run db:cleanup-logs # 清理到期日志,不删除未完成投递事实" -ForegroundColor Cyan
Write-Host "  严禁:日常更新不要执行 db:seed、不要执行 db:migrate:baseline。" -ForegroundColor Red
Write-Host ""
Write-Host "  See: bat/部署和更新方法.txt" -ForegroundColor Gray
Write-Host ""

Start-Process explorer.exe $ScriptDir

Write-Host "This window will close in 15 seconds..." -ForegroundColor Gray
Start-Sleep -Seconds 15
