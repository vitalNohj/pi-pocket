# Builds Pi-Pocket-Setup-<version>.exe on Windows: pinned Node.js, WebView2 SDK and Evergreen offline installers,
# Inno Setup, the desktop app, and the pi-pocket package (packaging/bundle-app.mjs). Setup needs no npm or network.
#
#   pwsh packaging/windows/build.ps1 -Version 0.30.0 [-OutDir out] [-Source <checkout>] [-SignThumbprint <SHA1>]
#
# -Source is the checkout to pack (default: the one this script is in), with -Version in its package.json.
# -SignThumbprint signs Pi Pocket.exe, Setup, and its uninstaller with that certificate from the user's store.
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$OutDir = (Join-Path $PSScriptRoot "out"),
    [string]$Source = (Join-Path $PSScriptRoot "..\.."),
    [string]$SignThumbprint = "",
    [switch]$WithDesktopUpdate,
    [switch]$DesktopOnly,
    [switch]$TestBridge
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# To move to another Node.js, take the win-x64.zip line of https://nodejs.org/dist/v<version>/SHASUMS256.txt.
$NodeVersion = "26.13.1"
$NodeSha256 = "e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7"
# The Microsoft.Web.WebView2 SDK from nuget.org, not the Runtime.
$WebView2Version = "1.0.4370.26"
$WebView2Sha256 = "1c0dacac84b70109b3fd42f90c53a0ba942abc3a87590d7a4e0ccd86e4a06cf4"
# Use the direct URLs behind Microsoft's Evergreen Standalone Installer links (x64: 2124701, arm64: 2099616).
# Pin the bytes of the full offline installers, not the moving fwlinks or the small online bootstrapper.
$WebView2RuntimeSource = "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files"
$WebView2RuntimeX64 = "58f85fae-b5f5-4443-9b8d-6d4cf627d6f6/MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
$WebView2RuntimeX64Sha256 = "45769d66809a9652050f8a91ab5329881b65cc4123fe7c733841deefbef91bf6"
$WebView2RuntimeArm64 = "4f49ac14-882f-4840-ba6c-a46aae5eb1f0/MicrosoftEdgeWebView2RuntimeInstallerARM64.exe"
$WebView2RuntimeArm64Sha256 = "c46b7c12d7d873c69593aeff33aa537f4bd372c2f89293be714b561b5ed8651a"
# The SHA256 that https://github.com/jrsoftware/issrc/releases lists for the file.
$InnoVersion = "7.1.1"
$InnoSha256 = "8a5a6711c3766a6e5fb74f280ba0e3551e719ce94538d901fdbd1f8f9920b3f0"

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
    throw "Version '$Version' is not a version such as 0.29.0 or 0.30.0-beta.1"
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) "pi-pocket-setup-build"
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work, $OutDir | Out-Null

function Get-Checked([string]$Url, [string]$File, [string]$Sha256) {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing
    $actual = (Get-FileHash -Algorithm SHA256 $File).Hash.ToLowerInvariant()

    if ($actual -ne $Sha256) {
        throw "SHA256 of $Url is $actual, not the pinned $Sha256"
    }

    Write-Host "SHA256 matches: $actual"
}

if (-not $DesktopOnly) {
    $nodeName = "node-v$NodeVersion-win-x64"
    $nodeZip = Join-Path $work "$nodeName.zip"
    Get-Checked "https://nodejs.org/dist/v$NodeVersion/$nodeName.zip" $nodeZip $NodeSha256
    Expand-Archive -Path $nodeZip -DestinationPath $work
    $nodeDir = Join-Path $work $nodeName

    if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
        throw "The Node.js zip has no $nodeName\node.exe"
    }

    $appDir = Join-Path $work "app"
    & (Join-Path $nodeDir "node.exe") (Join-Path $PSScriptRoot "..\bundle-app.mjs") $Source $appDir $Version

    if ($LASTEXITCODE -ne 0) {
        throw "bundle-app.mjs exited with $LASTEXITCODE"
    }
}

# C# 5: the compiler that every Windows 10 and 11 has in its .NET Framework 4.x.
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $csc)) {
    throw "No C# compiler of the .NET Framework at $csc"
}

$desktop = Join-Path $work "desktop"
New-Item -ItemType Directory -Force $desktop | Out-Null

# A NuGet package is a zip. Ship the .NET Framework assemblies and the loader that matches the x64 app.
$webViewZip = Join-Path $work "webview2.zip"
$webView = Join-Path $work "webview2"
Get-Checked "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$WebView2Version/microsoft.web.webview2.$WebView2Version.nupkg" $webViewZip $WebView2Sha256
Expand-Archive -Path $webViewZip -DestinationPath $webView
$webCore = Join-Path $desktop "Microsoft.Web.WebView2.Core.dll"
$webForms = Join-Path $desktop "Microsoft.Web.WebView2.WinForms.dll"
Copy-Item (Join-Path $webView "lib\net462\Microsoft.Web.WebView2.Core.dll") $webCore
Copy-Item (Join-Path $webView "lib\net462\Microsoft.Web.WebView2.WinForms.dll") $webForms
Copy-Item (Join-Path $webView "build\native\x64\WebView2Loader.dll") $desktop
Copy-Item (Join-Path $webView "LICENSE.txt") (Join-Path $desktop "WebView2-License.txt")

$numeric = ($Version -replace '-.*$', '') + ".0"
$launcherSource = Get-Content -Raw (Join-Path $PSScriptRoot "PiPocket.cs")
$launcherSource = $launcherSource.Replace('Version = "0.0.0-dev"', "Version = `"$Version`"")
$launcherSource = $launcherSource.Replace('NumericVersion = "0.0.0.0"', "NumericVersion = `"$numeric`"")
$sourceFile = Join-Path $desktop "PiPocket.cs"
[IO.File]::WriteAllText($sourceFile, $launcherSource, (New-Object Text.UTF8Encoding $false))
$appExe = Join-Path $desktop "Pi Pocket.exe"
# Reference the contracts directly. Recent Windows.winmd files forward these types to the SDK contracts.
$sdkReferences = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\References'
$contracts = @('Windows.Foundation.FoundationContract', 'Windows.Foundation.UniversalApiContract')
$sdk = Get-ChildItem $sdkReferences -Directory | Where-Object {
    (Test-Path (Join-Path $_.FullName $contracts[0])) -and (Test-Path (Join-Path $_.FullName $contracts[1]))
} | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Install the Windows 10 or 11 SDK to build native notifications.' }
$contractReferences = foreach ($contract in $contracts) {
    $file = Get-ChildItem (Join-Path $sdk.FullName $contract) -Filter "$contract.winmd" -File -Recurse |
        Sort-Object { [version]$_.Directory.Name } -Descending | Select-Object -First 1
    if (-not $file) { throw "The Windows SDK is missing $contract.winmd." }
    "/r:$($file.FullName)"
}
# The SDK contracts declare the original System.Runtime 4.0 facade. Prefer the matching desktop reference.
$targetFacades = Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\Facades'
$runtimeFacade = Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL\System.Runtime\v4.0_4.0.0.0__b03f5f7f11d50a3a\System.Runtime.dll'
if (-not (Test-Path -LiteralPath $runtimeFacade -PathType Leaf)) {
    $runtimeFacade = Join-Path $targetFacades 'System.Runtime.dll'
}
if (-not (Test-Path -LiteralPath $runtimeFacade -PathType Leaf)) {
    throw 'The .NET Framework System.Runtime reference is missing.'
}
# The WinRT event signatures also use EventRegistrationToken from this facade.
$interopName = 'System.Runtime.InteropServices.WindowsRuntime.dll'
$interopFacade = Join-Path (Split-Path $csc -Parent) $interopName
if (-not (Test-Path -LiteralPath $interopFacade -PathType Leaf)) {
    $interopFacade = Join-Path $targetFacades $interopName
}
if (-not (Test-Path -LiteralPath $interopFacade -PathType Leaf)) {
    throw "The .NET Framework $interopName reference is missing. Install the .NET Framework 4.8 targeting pack."
}
$runnerSource = Join-Path $PSScriptRoot "Desktop\ProcessesRunner.cs"
$desktopSources = @(Get-ChildItem (Join-Path $PSScriptRoot "Desktop") -Filter '*.cs' -File |
    Where-Object FullName -ne $runnerSource | ForEach-Object FullName)
$bootstrap = Join-Path $PSScriptRoot "..\desktop\bridge\bootstrap.js"
$windowScript = Join-Path $PSScriptRoot '..\desktop\window\host.js'
# The .NET 4.8 targeting pack's fallback facade can have a newer version than the WinRT contract reference.
$compile = @(
    '/nologo', '/optimize+', '/platform:x64', '/warnaserror+', '/warnaserror-:1701', '/codepage:65001',
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', '/r:System.Xml.Linq.dll',
    '/r:System.Runtime.WindowsRuntime.dll', "/r:$runtimeFacade", "/r:$interopFacade", "/r:$webCore", "/r:$webForms",
    "/resource:$bootstrap,PocketBridge.js", "/resource:$windowScript,PiPocket.Window.js",
    $sourceFile, (Join-Path $PSScriptRoot 'PocketWindow.cs')
) + $contractReferences + $desktopSources
& $csc /target:winexe "/out:$appExe" "/win32icon:$(Join-Path $PSScriptRoot 'pi-pocket.ico')" `
    "/win32manifest:$(Join-Path $PSScriptRoot 'PiPocket.manifest')" @compile

if ($LASTEXITCODE -ne 0) {
    throw "csc exited with $LASTEXITCODE"
}

$assets = New-Item -ItemType Directory (Join-Path $desktop "desktop-assets")
foreach ($name in @("controller", "protocol", "settings", "feed")) {
    Copy-Item -Recurse (Join-Path $PSScriptRoot "..\desktop\$name") $assets.FullName
}
$speechBundler = Join-Path $PSScriptRoot "..\desktop\bundle-dictation.mjs"
$speechRuntime = Join-Path $assets.FullName "controller\dictation\runtime"
if ($DesktopOnly) {
    node $speechBundler $Source $speechRuntime --from-checkout
} else {
    & (Join-Path $nodeDir "node.exe") $speechBundler (Join-Path $appDir "node_modules\pi-pocket") $speechRuntime
}
if ($LASTEXITCODE -ne 0) { throw "bundle-dictation.mjs exited with $LASTEXITCODE" }
Write-Host "Built $appExe"

if ($TestBridge) {
    $bridgeTest = Join-Path $desktop 'bridge-tests.exe'
    & $csc /target:exe /main:PiPocket.BridgeWindowsTests "/out:$bridgeTest" @compile `
        (Join-Path $PSScriptRoot '..\..\test\desktop\BridgeWindowsTests.cs')
    if ($LASTEXITCODE -ne 0) { throw "Bridge test compilation exited with $LASTEXITCODE" }
    & $bridgeTest
    if ($LASTEXITCODE -ne 0) { throw "Bridge tests exited with $LASTEXITCODE" }
}

$runnerHost = Join-Path $desktop "runner-host.exe"
& $csc /nologo /target:exe /optimize+ /platform:x64 /warnaserror+ `
    "/out:$runnerHost" $runnerSource

if ($LASTEXITCODE -ne 0) {
    throw "csc could not build the runner process adapter"
}

$innoSetup = Join-Path $work "innosetup-$InnoVersion-x64.exe"
$innoDir = Join-Path $work "inno"
Get-Checked "https://github.com/jrsoftware/issrc/releases/download/is-$($InnoVersion.Replace('.', '_'))/innosetup-$InnoVersion-x64.exe" $innoSetup $InnoSha256
$inno = Start-Process -FilePath $innoSetup -Wait -PassThru -ArgumentList @(
    "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/CURRENTUSER", "/NOICONS", "/DIR=`"$innoDir`""
)

if ($inno.ExitCode -ne 0) {
    throw "Inno Setup's installer exited with $($inno.ExitCode)"
}

$iscc = Join-Path $innoDir "ISCC.exe"

if (-not (Test-Path $iscc)) {
    throw "No ISCC.exe in $innoDir"
}

$arguments = @("/Qp", "/DAppVersion=$Version", "/DOutputDir=$OutDir", "/DDesktopDir=$desktop")

if ($SignThumbprint -ne "") {
    $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $signtool = Get-ChildItem -Path $kits -Recurse -Filter signtool.exe |
        Where-Object { $_.FullName -match '\\x64\\' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1

    if ($null -eq $signtool) {
        throw "No signtool.exe in $kits"
    }

    foreach ($exe in @($appExe, $runnerHost)) {
        & $signtool.FullName sign /sha1 $SignThumbprint /fd sha256 /tr http://timestamp.digicert.com /td sha256 $exe
        if ($LASTEXITCODE -ne 0) {
            throw "signtool could not sign $exe"
        }
    }

    # ISCC puts a quote for each `$q and the quoted file name for `$f.
    $arguments += "/Ssigntool=`$q$($signtool.FullName)`$q sign /sha1 $SignThumbprint /fd sha256 /tr http://timestamp.digicert.com /td sha256 `$f"
    $arguments += "/DSign"
}

function Build-Setup([string[]]$Defines, [string]$Name) {
    & $iscc @arguments @Defines (Join-Path $PSScriptRoot "pi-pocket.iss")

    if ($LASTEXITCODE -ne 0) {
        throw "ISCC exited with $LASTEXITCODE"
    }

    $setup = Join-Path $OutDir "$Name-$Version.exe"
    Write-Host "Built $setup ($([math]::Round((Get-Item $setup).Length / 1MB, 1)) MB)"
    Write-Host "SHA256 $((Get-FileHash -Algorithm SHA256 $setup).Hash.ToLowerInvariant())"
}

if (-not $DesktopOnly) {
    $runtimeX64 = Join-Path $work "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
    $runtimeArm64 = Join-Path $work "MicrosoftEdgeWebView2RuntimeInstallerARM64.exe"
    Get-Checked "$WebView2RuntimeSource/$WebView2RuntimeX64" $runtimeX64 $WebView2RuntimeX64Sha256
    Get-Checked "$WebView2RuntimeSource/$WebView2RuntimeArm64" $runtimeArm64 $WebView2RuntimeArm64Sha256
    Build-Setup -Defines @("/DNodeDir=$nodeDir", "/DAppDir=$appDir", "/DWebView2RuntimeDir=$work") -Name "Pi-Pocket-Setup"
}

if ($DesktopOnly -or $WithDesktopUpdate) {
    Build-Setup -Defines @("/DDesktopUpdate") -Name "Pi-Pocket-Desktop-Update"
}

Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
