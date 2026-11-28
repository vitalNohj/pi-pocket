# The hosted image already has WebView2. Verify that Setup leaves it alone and that
# the installed app can show Home and Desktop Settings with its network access blocked.
param(
    [Parameter(Mandatory)][ValidateSet('Record', 'OfflineHome', 'Preserved')][string]$Phase,
    [string]$InputDriver
)

$ErrorActionPreference = 'Stop'
$client = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$keys = @("HKLM:\SOFTWARE\WOW6432Node\$client", "HKCU:\SOFTWARE\$client")
$baseline = Join-Path $env:RUNNER_TEMP 'webview2-before-setup.json'

function Read-Registrations {
    $versions = @{}
    foreach ($key in $keys) {
        $value = Get-ItemPropertyValue -LiteralPath $key -Name pv -ErrorAction SilentlyContinue
        $version = $null
        if ([version]::TryParse($value, [ref]$version) -and $version -gt [version]'0.0.0.0') {
            $versions[$key] = $value
        }
    }
    return $versions
}

if ($Phase -eq 'Record') {
    $versions = Read-Registrations
    if ($versions.Count -eq 0) { throw 'This test requires a runner with WebView2 already installed.' }
    Write-Host "Preloaded WebView2 version(s): $($versions.Values -join ', ')"
    $versions | ConvertTo-Json | Set-Content -LiteralPath $baseline
    return
}

if ($Phase -eq 'Preserved') {
    $before = Get-Content -Raw -LiteralPath $baseline | ConvertFrom-Json -AsHashtable
    $after = Read-Registrations
    foreach ($key in $before.Keys) {
        if (-not $after.ContainsKey($key) -or [version]$after[$key] -lt [version]$before[$key]) {
            throw 'Setup or uninstall removed or downgraded a WebView2 registration.'
        }
    }
    foreach ($name in @('setup.log', 'setup-again.log', 'setup-newer.log', 'setup-no-startup.log')) {
        $log = Get-Content -Raw -LiteralPath (Join-Path $env:RUNNER_TEMP $name)
        # Allow the independent Evergreen updater to advance the registry version, but Setup must never run it.
        if ($log -notmatch 'Keeping existing WebView2 Runtime [0-9.]+' -or $log -match 'Installing the bundled WebView2 Runtime') {
            throw "$name does not confirm that Setup skipped the WebView2 redistributable."
        }
    }
    Write-Host "Every Setup skipped the WebView2 redistributable; installed version(s) after uninstall: $($after.Values -join ', ')"
    return
}

$exe = Join-Path $env:APP 'Pi Pocket.exe'
$node = Join-Path $env:APP 'node\node.exe'
$runtimeRoots = @("${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application", "$env:LOCALAPPDATA\Microsoft\EdgeWebView\Application")
$browsers = @(Get-ChildItem -LiteralPath $runtimeRoots -Filter 'msedgewebview2.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName)
if ($browsers.Count -eq 0) { throw 'The preloaded WebView2 browser executable is missing.' }
$out = Join-Path $env:RUNNER_TEMP 'webview2-evidence'
New-Item -ItemType Directory -Path $out | Out-Null
$env:PI_POCKET_DESKTOP_STATE = Join-Path $out 'desktop'
$env:PI_POCKET_DIR = Join-Path $out 'server-data'
$profileDir = Join-Path $env:PI_POCKET_DESKTOP_STATE 'WebView2 profile'
$webLog = Join-Path $env:PI_POCKET_DESKTOP_STATE 'webview2.log'
$title = 'Desktop Settings — Pi Pocket'
$ruleGroup = "PiPocket-WebView2-CI-$([guid]::NewGuid())"
$disabledProfiles = @(Get-NetFirewallProfile | Where-Object Enabled -eq 'False' | Select-Object -ExpandProperty Name)
$app = $null

function Check-Window([string]$Action, [string]$Target) {
    & $InputDriver $app.Id $Action $title $Target
    if ($LASTEXITCODE -ne 0) { throw "Desktop window test failed: $Action $Target" }
}

try {
    foreach ($program in @($exe, $node) + $browsers) {
        New-NetFirewallRule -DisplayName "$ruleGroup $program" -Group $ruleGroup -Profile Any `
            -Direction Outbound -Action Block -Program $program | Out-Null
    }
    if ($disabledProfiles.Count) { Set-NetFirewallProfile -Name $disabledProfiles -Enabled True }
    $app = Start-Process -FilePath $exe -PassThru
    for ($try = 0; $try -lt 60 -and -not $app.HasExited; $try++) {
        if ((Test-Path -LiteralPath $webLog) -and
            (Select-String -LiteralPath $webLog -SimpleMatch 'The bundled Desktop Settings page loaded.' -Quiet)) { break }
        Start-Sleep -Seconds 1
    }
    if ($try -eq 60 -or $app.HasExited) { throw 'The installed offline Desktop Settings page did not load.' }
    Check-Window 'expect-text' 'Another server'
    Check-Window 'shot' (Join-Path $out 'home-offline.png')
    Check-Window 'press' 'Window'
    Check-Window 'expect-text' 'Title bar'
    Check-Window 'shot' (Join-Path $out 'settings-offline.png')
    $views = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Where-Object { $_.CommandLine -like "*$profileDir*" })
    if (-not $views.Count -or @($views | Where-Object { $_.ExecutablePath -notin $browsers }).Count) {
        throw 'The Settings WebView2 process did not use a network-blocked runtime executable.'
    }
    $prefs = Get-Content -Raw -LiteralPath (Join-Path $env:PI_POCKET_DESKTOP_STATE 'desktop.json') | ConvertFrom-Json
    if ($null -ne $prefs.preferences.home.mode -or (Get-ChildItem -LiteralPath $env:PI_POCKET_DIR -Force -ErrorAction SilentlyContinue)) {
        throw 'The app started a server before a choice in Home.'
    }
    Select-String -LiteralPath $webLog -Pattern 'Runtime:', 'The bundled Desktop Settings page loaded.' |
        ForEach-Object Line | Set-Content -LiteralPath (Join-Path $out 'runtime.txt')
    Write-Host 'Installed Home and Window Settings opened with the app and browser network blocked and no server running.'
}
finally {
    try {
        if ($null -ne $app -and -not $app.HasExited) {
            Start-Process -FilePath $exe -ArgumentList '--quit' -Wait
            if (-not $app.WaitForExit(30000)) { throw 'The offline Settings app did not quit.' }
        }
        if (Test-Path -LiteralPath $webLog) { Get-Content -LiteralPath $webLog }
    }
    finally {
        Remove-NetFirewallRule -Group $ruleGroup -ErrorAction SilentlyContinue
        if ($disabledProfiles.Count) { Set-NetFirewallProfile -Name $disabledProfiles -Enabled False }
    }
}
