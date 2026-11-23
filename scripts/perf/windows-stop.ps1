# Copy the trace before cleanup. Ctrl+C in the runner's terminal is the graceful stop.
[CmdletBinding()]
param([Parameter(Mandatory = $true, Position = 0)][string]$RunDirectory)
$ErrorActionPreference = 'Stop'

$item = Get-Item -LiteralPath $RunDirectory -ErrorAction SilentlyContinue
if (-not $item) { return }
$dir = $item.FullName
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$marker = Join-Path $dir '.perf-runner-owned'
if (-not $item.PSIsContainer -or $item.Parent.FullName -ne $temp -or
    $item.Name -notmatch '^pi-pocket-perf\.[a-f0-9]{12}$' -or
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    -not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    throw 'Not a run directory made by windows-runner.ps1; nothing stopped or removed.'
}

$pidFile = Join-Path $dir 'runner.pid'
if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    $runnerPid = 0
    if (-not [int]::TryParse([IO.File]::ReadAllText($pidFile), [ref]$runnerPid) -or $runnerPid -lt 1) {
        throw 'Invalid runner PID; nothing stopped or removed.'
    }
    $runner = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $runnerPid"
    if ($runner) {
        $cli = Join-Path $dir 'checkout\bin\pi-pocket.js'
        $preload = Join-Path $dir 'pid.cjs'
        $line = $runner.CommandLine
        if (-not $line -or $runner.Name -ne 'node.exe' -or
            $line.IndexOf($cli, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
            $line.IndexOf($preload, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
            $line -notmatch '\s"?runner"?\s+"?start"?\s*$') {
            throw 'The saved PID is not the test runner. No process was stopped and no files were removed.'
        }
        $process = Get-Process -Id $runnerPid -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -InputObject $process
            Wait-Process -InputObject $process -Timeout 10
        }
    }
}

# Remove the fixture junction itself, never recurse through its target.
$alias = Get-Item -LiteralPath (Join-Path $dir 'work\alias') -ErrorAction SilentlyContinue
if ($alias -and ($alias.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    [IO.Directory]::Delete($alias.FullName)
}
Remove-Item -LiteralPath $dir -Recurse -Force
Write-Output "removed: $dir"
