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
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr w, ref Point p);
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
        SetCursorPos(p.X, p.Y);
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
        $app = Start-Process -FilePath $appExe -PassThru
        Wait-For 'sign in' { (Test-Path $log) -and (Select-String -Quiet -SimpleMatch '/api/me answered 200.' $log) }
        Wait-For 'open the main window' { [NativeWindowFixture]::Windows($app.Id).Length -eq 1 }
        $window = [NativeWindowFixture]::Windows($app.Id)[0]
        [void][NativeWindowFixture]::SetForegroundWindow($window)
        Start-Sleep -Seconds 2
        Screenshot "$chrome-light"
        if ($chrome -eq 'seamless') {
            [NativeWindowFixture]::Click($window, 616, 173)
            Wait-For 'save the session file without replacing the existing file' { Test-Path $completed }
            if ((Get-Content -Raw $completed).Trim() -ne 'Pi Pocket desktop download fixture' -or
                (Get-Content -Raw $existing).Trim() -ne 'Keep the existing file') { throw 'The saved file or the existing file is wrong' }
            Screenshot 'download'
            [void][NativeWindowFixture]::SetForegroundWindow($window)
            [NativeWindowFixture]::Click($window, 752, 173)
            Wait-For 'open the Save dialog' { [NativeWindowFixture]::Windows($app.Id).Length -ge 2 }
            Screenshot 'save-dialog'
            [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
            if (Test-Path (Join-Path $downloads 'window-dialog.txt')) { throw 'A general download skipped the dialog' }
        }
        [void][NativeWindowFixture]::SetForegroundWindow($window)
        [NativeWindowFixture]::Click($window, 480, 173)
        Wait-For 'open a second window' { [NativeWindowFixture]::Windows($app.Id).Length -eq 2 }
        Start-Sleep -Seconds 2
        Screenshot "$chrome-dark"
        Screenshot "$chrome-two-windows"
        Start-Process -FilePath $appExe -ArgumentList '--quit' -Wait
        Wait-For 'quit' { $app.Refresh(); $app.HasExited }
    }
    'System and Seamless; light and dark; a second window; existing name kept; Save dialog cancelled.' |
        Set-Content (Join-Path $out 'assertions.txt')
} finally {
    if ($app -and -not $app.HasExited) { Start-Process -FilePath $appExe -ArgumentList '--quit' -Wait }
    Move-Item -Force "$page.saved" $page
    Remove-Item -Force $existing, $completed -ErrorAction SilentlyContinue
}
