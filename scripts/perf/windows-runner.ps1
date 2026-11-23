# Run in the foreground in Windows PowerShell 5.1 or PowerShell 7.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$')]
    [string]$LinkCode,

    # Pin the checkout and the codeload fallback to the commit that contains this script.
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$Commit
)
$ErrorActionPreference = 'Stop'
$server = 'http://100.102.233.84:8898'
$repo = 'https://github.com/vitalNohj/pi-pocket.git'

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$(Split-Path -Leaf $Exe) failed (exit $LASTEXITCODE). See the error above."
    }
}

$node = $null
foreach ($appData in @($env:LOCALAPPDATA, $env:APPDATA)) {
    if (-not $appData) { continue }
    $runtimes = Join-Path $appData 'pi-pocket-gui\server\runtimes'
    if (-not (Test-Path -LiteralPath $runtimes -PathType Container)) { continue }
    foreach ($runtime in (Get-ChildItem -LiteralPath $runtimes -Directory | Sort-Object LastWriteTimeUtc -Descending)) {
        foreach ($relative in @('node.exe', 'bin\node.exe')) {
            $candidate = Join-Path $runtime.FullName $relative
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $node = $candidate; break }
        }
        if ($node) { break }
    }
    if ($node) { break }
}
if (-not $node) { throw 'Desktop Node not found. Install Pi Pocket and start its desktop server once.' }

$nodeDir = Split-Path -Parent $node
$npm = $null
foreach ($relative in @('node_modules\npm\bin\npm-cli.js', '..\node_modules\npm\bin\npm-cli.js', '..\lib\node_modules\npm\bin\npm-cli.js')) {
    $candidate = Join-Path $nodeDir $relative
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $npm = $candidate; break }
}
if (-not $npm) {
    $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
    if ($npmCommand) {
        $candidate = Join-Path (Split-Path -Parent $npmCommand.Source) 'node_modules\npm\bin\npm-cli.js'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $npm = $candidate }
    }
}
if (-not $npm) { throw 'npm-cli.js not found. Install npm for this Node runtime.' }

$dir = Join-Path ([IO.Path]::GetTempPath()) ('pi-pocket-perf.' + [guid]::NewGuid().ToString('N').Substring(0, 12))
$checkout = Join-Path $dir 'checkout'
$work = Join-Path $dir 'work'
$scratch = Join-Path $dir 'tmp'
$null = New-Item -ItemType Directory -Path $dir, $work, $scratch, (Join-Path $work 'child\nested'), (Join-Path $work 'second')
[IO.File]::WriteAllText((Join-Path $dir '.perf-runner-owned'), '')
Write-Output "Run directory (for windows-stop.ps1): $dir"

$savedEnv = @{}
foreach ($key in @('Path', 'TEMP', 'TMP', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'PI_POCKET_RUNNER_CONFIG', 'PI_POCKET_RUNNER_DAEMON', 'PI_POCKET_PERF', 'PI_POCKET_PERF_FILE')) {
    $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
Push-Location -LiteralPath $dir
try {
    $env:Path = "$nodeDir;$env:Path"
    $env:TEMP = $scratch
    $env:TMP = $scratch
    foreach ($key in @('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'PI_POCKET_RUNNER_DAEMON', 'PI_POCKET_PERF', 'PI_POCKET_PERF_FILE')) {
        [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    $env:PI_POCKET_RUNNER_CONFIG = Join-Path $dir 'runner.json'
    $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($git) {
        Invoke-Native $git.Source @('clone', '--quiet', '--depth', '1', '--single-branch', '--branch', 'perf/upstream', $repo, $checkout)
        $head = Invoke-Native $git.Source @('-C', $checkout, 'rev-parse', 'HEAD')
        if ($head -ne $Commit) {
            Invoke-Native $git.Source @('-C', $checkout, 'fetch', '--quiet', '--depth', '1', 'origin', $Commit)
            Invoke-Native $git.Source @('-C', $checkout, 'checkout', '--quiet', '--detach', $Commit)
        }
    } else {
        $archive = Join-Path $dir 'source.zip'
        Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/vitalNohj/pi-pocket/zip/$Commit" -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $dir
        Move-Item -LiteralPath (Join-Path $dir "pi-pocket-$Commit") -Destination $checkout
        Remove-Item -LiteralPath $archive
        Write-Warning 'Git not found. The fixture is not a Git repository, so its Changes panel cannot be measured.'
    }

    Set-Location -LiteralPath $checkout
    Invoke-Native $node @($npm, 'ci', '--cache', (Join-Path $dir 'npm-cache'), '--no-audit', '--no-fund')
    [IO.File]::WriteAllText((Join-Path $work 'small.txt'), "small fixture: original`n")
    [IO.File]::WriteAllText((Join-Path $work 'large.txt'), (('A' * 511 + "`n") * 100))
    [IO.File]::WriteAllText((Join-Path $work 'child\nested\leaf.txt'), "nested fixture`n")
    $null = New-Item -ItemType Junction -Path (Join-Path $work 'alias') -Target (Join-Path $work 'child')
    if ($git) {
        Invoke-Native $git.Source @('-C', $work, 'init', '-q')
        [IO.File]::AppendAllText((Join-Path $work '.git\info\exclude'), "`n.runner-perf.jsonl`n/alias/`n")
        Invoke-Native $git.Source @('-C', $work, 'add', '--', 'small.txt', 'large.txt', 'child/nested/leaf.txt')
        Invoke-Native $git.Source @('-C', $work, '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/no-hooks', '-c', 'commit.gpgsign=false', '-c', 'user.name=Pocket Perf', '-c', 'user.email=perf@example.invalid', 'commit', '-qm', 'fixture')
    }

    $cli = Join-Path $checkout 'bin\pi-pocket.js'
    Invoke-Native $node @($cli, 'runner', 'link', $server, $LinkCode)
    # The fixture alone is auto-approved. Do not read or modify the app's link file.
    $configure = Join-Path $dir 'configure.cjs'
    [IO.File]::WriteAllText($configure, @'
const fs = require("node:fs");
const file = process.env.PI_POCKET_RUNNER_CONFIG;
const folder = fs.realpathSync(process.argv[2]);
const link = JSON.parse(fs.readFileSync(file, "utf8"));
link.settings = { ...link.settings, confirm: false, folders: [folder], network: false };
fs.writeFileSync(file, JSON.stringify(link));
'@)
    Invoke-Native $node @($configure, $work)

    $env:PI_POCKET_PERF = '1'
    $env:PI_POCKET_PERF_FILE = Join-Path $work '.runner-perf.jsonl'
    $pidModule = Join-Path $dir 'pid.cjs'
    [IO.File]::WriteAllText($pidModule, 'require("node:fs").writeFileSync(require("node:path").join(__dirname,"runner.pid"),String(process.pid));')
    Write-Output "Fixture folder: $work"
    Write-Output "Runner timings: $env:PI_POCKET_PERF_FILE"
    Invoke-Native $node @('--require', $pidModule, $cli, 'runner', 'start')
} finally {
    Pop-Location
    foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process') }
}
