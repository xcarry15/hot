param(
    [switch]$CheckOnly,
    [switch]$RefreshDependencies
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DirectorySeparator = [System.IO.Path]::DirectorySeparatorChar
$ProjectRootPrefix = $ProjectRoot.TrimEnd($DirectorySeparator) + $DirectorySeparator
Set-Location -LiteralPath $ProjectRoot

function Stop-WithError {
    param([string]$Message)
    throw $Message
}

function Invoke-Npm {
    param([string[]]$Arguments)

    & $script:NpmPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Remove-ProjectDirectory {
    param([string]$RelativePath)

    $Target = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $RelativePath))
    if (-not $Target.StartsWith($ProjectRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-WithError "Refusing to remove a directory outside the project: $Target"
    }

    if (Test-Path -LiteralPath $Target) {
        Remove-Item -LiteralPath $Target -Recurse -Force
    }
}

try {
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host '  Hot2 Local Initialization' -ForegroundColor Cyan
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'This will delete the local SQLite database and .next.' -ForegroundColor Yellow
    Write-Host 'Existing node_modules will be reused unless -RefreshDependencies is provided.' -ForegroundColor Yellow
    Write-Host 'The existing .env file will be preserved.' -ForegroundColor Yellow
    Write-Host ''

    if (-not $CheckOnly) {
        $Confirmation = Read-Host 'Type RESET to continue'
        if ($Confirmation -ne 'RESET') {
            Write-Host 'Cancelled.'
            exit 0
        }
    }

    $NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $NodeCommand) {
        Stop-WithError 'Node.js was not found. Install Node.js 20.9.0 or newer.'
    }
    if (-not $NpmCommand) {
        Stop-WithError 'npm was not found.'
    }
    $script:NpmPath = $NpmCommand.Source

    $NodeVersionText = ((& $NodeCommand.Source --version) -replace '^v', '').Trim()
    $NodeVersion = [version]$NodeVersionText
    if ($NodeVersion -lt [version]'20.9.0') {
        Stop-WithError "Node.js 20.9.0 or newer is required. Current: $NodeVersionText"
    }

    $NpmVersionText = ((& $script:NpmPath --version) | Select-Object -First 1).Trim()
    $NpmVersion = [version]$NpmVersionText
    if ($NpmVersion.Major -lt 10) {
        Stop-WithError "npm 10 or newer is required. Current: $NpmVersionText"
    }

    foreach ($RequiredFile in @('package.json', 'package-lock.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $RequiredFile) -PathType Leaf)) {
            Stop-WithError "Missing required file: $RequiredFile"
        }
    }

    $EnvPath = Join-Path $ProjectRoot '.env'
    $EnvExamplePath = Join-Path $ProjectRoot '.env.example'
    if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
        if (-not (Test-Path -LiteralPath $EnvExamplePath -PathType Leaf)) {
            Stop-WithError 'Both .env and .env.example are missing.'
        }
        Copy-Item -LiteralPath $EnvExamplePath -Destination $EnvPath
        Write-Host '[env] Created .env from .env.example.' -ForegroundColor Gray
    } else {
        Write-Host '[env] Preserving the existing .env.' -ForegroundColor Gray
    }

    $DatabaseLine = Get-Content -LiteralPath $EnvPath |
        Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } |
        Select-Object -First 1
    if (-not $DatabaseLine) {
        Stop-WithError 'DATABASE_URL is missing from .env.'
    }
    $DatabaseUrl = ($DatabaseLine -replace '^\s*DATABASE_URL\s*=\s*', '').Trim()
    $DatabaseUrl = $DatabaseUrl.Trim([char[]]@(39, 34))
    if ($DatabaseUrl -ne 'file:../db/custom.db') {
        Stop-WithError 'DATABASE_URL in .env must be file:../db/custom.db.'
    }

    if ($CheckOnly) {
        Write-Host 'Preflight check passed.' -ForegroundColor Green
        exit 0
    }

    $RequiredDependencyFiles = @(
        'node_modules\.bin\next.cmd',
        'node_modules\.bin\prisma.cmd',
        'node_modules\.bin\tsx.cmd'
    )
    $MissingDependencyCount = ($RequiredDependencyFiles |
        Where-Object { -not (Test-Path -LiteralPath (Join-Path $ProjectRoot $_) -PathType Leaf) } |
        Measure-Object).Count
    $ReuseDependencies = -not $RefreshDependencies -and $MissingDependencyCount -eq 0

    Write-Host '[1/7] Stopping Node processes that belong to this project...'
    $Pm2Command = Get-Command pm2.cmd -ErrorAction SilentlyContinue
    if ($Pm2Command) {
        try {
            & $Pm2Command.Source delete h2-hot2 *> $null
        } catch {
            # The PM2 application may not exist; local initialization can continue.
        }
    }

    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

    Write-Host '[2/7] Removing the local database and generated files...'
    $DatabaseDirectory = Join-Path $ProjectRoot 'db'
    New-Item -ItemType Directory -Path $DatabaseDirectory -Force | Out-Null
    foreach ($DatabaseFile in @('custom.db', 'custom.db-journal', 'custom.db-wal', 'custom.db-shm')) {
        Remove-Item -LiteralPath (Join-Path $DatabaseDirectory $DatabaseFile) -Force -ErrorAction SilentlyContinue
    }
    Remove-ProjectDirectory '.next'
    if (-not $ReuseDependencies) {
        Remove-ProjectDirectory 'node_modules'
    }

    if ($ReuseDependencies) {
        Write-Host '[3/7] Reusing existing node_modules...' -ForegroundColor Gray
    } else {
        Write-Host '[3/7] Installing dependencies from package-lock.json...'
        Invoke-Npm @('ci', '--prefer-offline', '--no-audit', '--no-fund')
    }

    Write-Host '[4/7] Applying migrations and generating Prisma Client...'
    Invoke-Npm @('run', 'db:migrate:deploy')
    Invoke-Npm @('run', 'db:generate')

    Write-Host '[5/7] Seeding the new database...'
    Invoke-Npm @('run', 'db:seed')

    Write-Host '[6/7] Optimizing and checking SQLite...'
    Invoke-Npm @('run', 'db:optimize')
    Invoke-Npm @('run', 'db:migrate:status')

    Write-Host '[7/7] Starting the development server...'
    Write-Host 'URL: http://localhost:3011' -ForegroundColor Green
    Write-Host 'Press Ctrl+C to stop the server.' -ForegroundColor Gray
    Write-Host ''

    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoLogo',
        '-NoProfile',
        '-Command',
        "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3011'"
    )

    & $script:NpmPath run dev
    exit $LASTEXITCODE
} catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
