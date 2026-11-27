# Run after the normal installed app smoke has quit. Do not change any files outside the runner's disposable profile.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NativeWindowFixture {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    delegate bool Visit(IntPtr w, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(Visit fn, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, out int process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr w);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr w);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w, out Rect r);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr w, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr w, ref Point p);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr w);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr w, int command);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr w, int attribute, out Rect bounds, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    public static IntPtr[] Windows(int process) {
        var windows = new List<IntPtr>();
        EnumWindows((w, p) => {
            int owner;
            Rect r;
            GetWindowThreadProcessId(w, out owner);
            if (owner == process && IsWindowVisible(w) && GetWindowRect(w, out r) && r.Right - r.Left >= 400) {
                windows.Add(w);
            }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
    public static void Click(IntPtr w, int x, int y) {
        var p = new Point { X = x, Y = y };
        ClientToScreen(w, ref p);
        ClickScreen(p.X, p.Y);
    }
    public static void ClickMaximize(IntPtr w) {
        Rect window, buttons;
        if (!GetWindowRect(w, out window) || DwmGetWindowAttribute(w, 5, out buttons, Marshal.SizeOf(typeof(Rect))) != 0 ||
            buttons.Right <= buttons.Left || buttons.Bottom <= buttons.Top) {
            throw new InvalidOperationException("No native caption bounds");
        }
        ClickScreen(window.Left + (buttons.Left + buttons.Right) / 2, window.Top + (buttons.Top + buttons.Bottom) / 2);
    }
    static void ClickScreen(int x, int y) {
        SetCursorPos(x, y);
        mouse_event(2, 0, 0, 0, UIntPtr.Zero);
        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
    }
}
'@
[void][NativeWindowFixture]::SetProcessDPIAware()

function Wait-For($reason, $condition) {
    foreach ($try in 1..60) {
        if (& $condition) { return }
        Start-Sleep -Seconds 1
    }
    throw "The window fixture did not $reason."
}

function Request-Quit {
    $request = Start-Process -FilePath $appExe -ArgumentList '--quit' -PassThru
    if (-not $request.WaitForExit(10000)) {
        Stop-Process -Id $request.Id -ErrorAction SilentlyContinue
        throw 'The window fixture could not send Quit.'
    }
    if ($request.ExitCode -ne 0) { throw 'The Quit command failed.' }
}

function Screenshot($file) {
    $rect = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = [System.Drawing.Bitmap]::new($rect.Width, $rect.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
        $bitmap.Save((Join-Path $out "$file.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

$appExe = Join-Path $env:APP 'Pi Pocket.exe'
$log = Join-Path $env:APP 'launcher.log'
$page = Join-Path (Split-Path $env:MANIFEST) 'web\app.js'
$out = Join-Path $env:RUNNER_TEMP 'window-evidence'
$env:PI_POCKET_DESKTOP_STATE = Join-Path $env:RUNNER_TEMP 'window-state'
$env:PI_POCKET_DIR = Join-Path $env:RUNNER_TEMP 'window-data'
New-Item -ItemType Directory -Force $out, $env:PI_POCKET_DESKTOP_STATE | Out-Null
# Select local Home only in the fixture. A real fresh install must show both choices.
Set-Content -LiteralPath (Join-Path $env:PI_POCKET_DESKTOP_STATE 'desktop.json') -Encoding utf8NoBOM `
    -Value '{"schemaVersion":1,"preferences":{"home":{"mode":"local"}}}'
$preferences = Join-Path $env:PI_POCKET_DESKTOP_STATE 'window.json'
$downloads = Join-Path $env:USERPROFILE 'Downloads'
New-Item -ItemType Directory -Force $downloads | Out-Null
$existing = Join-Path $downloads 'window-fixture.txt'
$completed = Join-Path $downloads 'window-fixture (2).txt'
Set-Content -Path $existing -Value 'Keep the existing file'
Copy-Item $page "$page.saved"
try {
    node "${PSScriptRoot}/window-fixture.mjs" $env:MANIFEST (Join-Path $env:RUNNER_TEMP 'window-files')
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the window fixture' }
    foreach ($chrome in @('system', 'seamless')) {
        @{ titleBar = $chrome } | ConvertTo-Json -Compress | Set-Content $preferences -Encoding utf8NoBOM
        if (Test-Path $log) { Move-Item -Force $log (Join-Path $env:RUNNER_TEMP "window-before-$chrome.log") }
        $app = Start-Process -FilePath $appExe -PassThru
        Wait-For 'sign in' { (Test-Path $log) -and (Select-String -Quiet -SimpleMatch '/api/me answered 200.' $log) }
        Wait-For 'open the main window' { [NativeWindowFixture]::Windows($app.Id).Length -eq 1 }
        $window = [NativeWindowFixture]::Windows($app.Id)[0]
        $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        [void][NativeWindowFixture]::SetWindowPos($window, [IntPtr]::Zero, ($work.X + 36), ($work.Y + 36), 900, 625, 0x14)
        [void][NativeWindowFixture]::SetForegroundWindow($window)
        Start-Sleep -Seconds 2
        Screenshot "$chrome-light"
        if ($chrome -eq 'seamless') {
            [NativeWindowFixture]::ClickMaximize($window)
            Wait-For 'maximize with the native button' { [NativeWindowFixture]::IsZoomed($window) }
            Start-Sleep -Seconds 1 # The browser paints the enlarged surface after the HWND changes state.
            Screenshot 'seamless-maximized'
            [void][NativeWindowFixture]::ShowWindow($window, 9) # SW_RESTORE
            Wait-For 'restore the window' { -not [NativeWindowFixture]::IsZoomed($window) }
            Start-Sleep -Seconds 1
            [NativeWindowFixture]::Click($window, 616, 212)
            Wait-For 'save the session file without replacing the existing file' { Test-Path -LiteralPath $completed }
            if ((Get-Content -Raw $completed).Trim() -ne 'Pi Pocket desktop download fixture' -or
                (Get-Content -Raw $existing).Trim() -ne 'Keep the existing file') { throw 'The saved file or the existing file is wrong' }
            Start-Sleep -Seconds 2 # Let Explorer reveal the saved file before the capture.
            Screenshot 'download'
            [void][NativeWindowFixture]::SetForegroundWindow($window)
            [NativeWindowFixture]::Click($window, 752, 212)
            Wait-For 'open the Save dialog' { [NativeWindowFixture]::Windows($app.Id).Length -ge 2 }
            Screenshot 'save-dialog'
            [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
            Wait-For 'close the Save dialog' { [NativeWindowFixture]::Windows($app.Id).Length -eq 1 }
            if (Test-Path (Join-Path $downloads 'window-dialog.txt')) { throw 'A general download skipped the dialog' }
        }
        [void][NativeWindowFixture]::SetForegroundWindow($window)
        [NativeWindowFixture]::Click($window, 344, 212)
        Start-Sleep -Seconds 2
        Screenshot "$chrome-dark"
        [NativeWindowFixture]::Click($window, 480, 212)
        Wait-For 'open a second window' { [NativeWindowFixture]::Windows($app.Id).Length -eq 2 }
        $extra = [NativeWindowFixture]::Windows($app.Id) | Where-Object { $_ -ne $window } | Select-Object -First 1
        [void][NativeWindowFixture]::SetWindowPos($extra, [IntPtr]::Zero, ($work.X + 340), ($work.Y + 160), 620, 510, 0x14)
        Start-Sleep -Seconds 2
        Screenshot "$chrome-two-windows"
        Request-Quit
        Wait-For 'quit' { $app.Refresh(); $app.HasExited }
    }
    'System and Seamless; light and dark; native maximize; a second window; existing name kept; Save dialog cancelled.' |
        Set-Content (Join-Path $out 'assertions.txt')
} catch {
    Screenshot 'failure'
    Get-ChildItem -LiteralPath $downloads -Filter 'window-fixture*' | Select-Object Name, Length | Out-Host
    if (Test-Path $log) { Select-String -Pattern 'download|/api/me' $log | Out-Host }
    throw
} finally {
    if ($app -and -not $app.HasExited) {
        try { Request-Quit } catch { Write-Warning $_.Exception.Message }
    }
    Move-Item -Force "$page.saved" $page
    Remove-Item -Force $existing, $completed -ErrorAction SilentlyContinue
}
