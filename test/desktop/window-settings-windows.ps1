# Called by the installed-window fixture. Drive the shipped Settings UI, not a test bridge.
$index = Join-Path (Split-Path $env:MANIFEST) 'web\index.html'
$wallpaper = Join-Path $env:RUNNER_TEMP 'window-backdrop.bmp'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Pi Pocket.lnk'
Copy-Item $index "$index.evidence-original"
try {
    node "$PSScriptRoot/window-evidence.mjs" wallpaper $wallpaper
    if ($LASTEXITCODE -ne 0 -or -not [NativeWindowFixture]::SystemParametersInfo(20, 0, $wallpaper, 3)) { throw 'Could not set runner wallpaper' }
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name EnableTransparency -Value 1
    foreach ($mode in @('light', 'dark')) {
        node "$PSScriptRoot/window-evidence.mjs" theme $index $mode
        if ($LASTEXITCODE -ne 0) { throw 'Could not select the screenshot theme' }
        if (Test-Path $log) { Move-Item -Force $log (Join-Path $env:RUNNER_TEMP "settings-before-$mode.log") }
        $app = Start-Process -FilePath $appExe -PassThru
        Wait-For 'open the real Pi Pocket page' { (Test-Path $log) -and (Select-String -Quiet -SimpleMatch '/api/me answered 200.' $log) -and [NativeWindowFixture]::Windows($app.Id).Length -eq 1 }
        $main = [NativeWindowFixture]::Windows($app.Id)[0]
        $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $width = [Math]::Min($work.Width - 100, 1120)
        $height = [Math]::Min($work.Height - 95, 760)
        [void][NativeWindowFixture]::SetWindowPos($main, [IntPtr]::Zero, ($work.X + 48), ($work.Y + 42), $width, $height, 0x14)
        if ($mode -eq 'light') {
            $handle = Open-Settings $app $main
            [NativeWindowFixture]::Click($handle, 75, 290) # Window
            [NativeWindowFixture]::Click($handle, 266, 202) # Close to tray
            Wait-For 'save Close to tray off' { Saved 'window' 'closeToTray' $false }
            [NativeWindowFixture]::Click($handle, 266, 202)
            Wait-For 'save Close to tray on' { Saved 'window' 'closeToTray' $true }
            if (-not (Test-Path $startup)) { [NativeWindowFixture]::Click($handle, 266, 235) }
            Wait-For 'register Launch at login with Windows' { Test-Path $startup }
            if ((New-Object -ComObject WScript.Shell).CreateShortcut($startup).Arguments -ne '--login') { throw 'Settings created the wrong Startup shortcut' }
            [NativeWindowFixture]::Click($handle, 266, 267)
            Wait-For 'save Start hidden' { Saved 'window' 'startHidden' $true }

            Settings-Select $handle 369 '{END}'
            Wait-For 'apply System title bar' { (Saved 'window' 'titleBar' 'system') -and [NativeWindowFixture]::FrameTop($main) -gt 20 }
            Settings-Select $handle 369 '{HOME}'
            Wait-For 'apply Seamless title bar' { (Saved 'window' 'titleBar' 'seamless') -and [NativeWindowFixture]::FrameTop($main) -lt 20 }
            Settings-Select $handle 479 '{END}'
            Wait-For 'save browser link routing' { Saved 'window' 'links' 'browser' }
            Settings-Select $handle 479 '{HOME}'
            Wait-For 'save app link routing' { Saved 'window' 'links' 'app' }
            [NativeWindowFixture]::Click($handle, 266, 520)
            Wait-For 'register the global shortcut' { Saved 'window' 'shortcutEnabled' $true }
            Screenshot 'desktop-settings-window'

            [NativeWindowFixture]::Click($handle, 75, 327) # Appearance
            [NativeWindowFixture]::Click($handle, 266, 253)
            Wait-For 'enable Acrylic' { (Saved 'appearance' 'transparent' $true) -and [NativeWindowFixture]::Backdrop($main) -eq 3 }
            [NativeWindowFixture]::Click($handle, 350, 323)
            [System.Windows.Forms.SendKeys]::SendWait('^a28{TAB}')
            Wait-For 'save opacity' { Saved 'appearance' 'opacity' 28 }
            Settings-Select $handle 398 '{END}'
            Wait-For 'apply Mica' { (Saved 'appearance' 'material' 'mica') -and [NativeWindowFixture]::Backdrop($main) -eq 2 }
            Settings-Select $handle 398 '{HOME}'
            Wait-For 'restore Acrylic' { (Saved 'appearance' 'material' 'acrylic') -and [NativeWindowFixture]::Backdrop($main) -eq 3 }
            Screenshot 'desktop-settings-appearance'
            [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
            Wait-For 'return to Pi Pocket' { [NativeWindowFixture]::Windows($app.Id).Length -eq 1 }

            [void][NativeWindowFixture]::SetForegroundWindow($main)
            [System.Windows.Forms.SendKeys]::SendWait('^+p')
            Wait-For 'hide Pi Pocket with the global shortcut' { [NativeWindowFixture]::Windows($app.Id).Length -eq 0 }
            [System.Windows.Forms.SendKeys]::SendWait('^+p')
            Wait-For 'show Pi Pocket with the global shortcut' { [NativeWindowFixture]::Windows($app.Id).Length -eq 1 }
        }
        if ([NativeWindowFixture]::Backdrop($main) -ne 3 -or [NativeWindowFixture]::FrameTop($main) -ge 20) { throw 'The restored window does not use Seamless and Acrylic' }
        [void][NativeWindowFixture]::SetForegroundWindow($main)
        Start-Sleep -Seconds 2
        Screenshot "seamless-see-through-$mode"
        Request-Quit
        Wait-For 'quit the screenshot app' { $app.Refresh(); $app.HasExited }
    }

    $app = Start-Process -FilePath $appExe -ArgumentList '--login' -PassThru
    Wait-For 'start the local server at login' { Test-Path (Join-Path $env:PI_POCKET_DIR 'launcher-running.json') }
    Start-Sleep -Seconds 2
    if ([NativeWindowFixture]::Windows($app.Id).Length -ne 0) { throw 'Start hidden showed a window at login' }
    [System.Windows.Forms.SendKeys]::SendWait('^+p')
    Wait-For 'restore the saved global shortcut after login' { [NativeWindowFixture]::Windows($app.Id).Length -eq 1 }
    $handle = Open-Settings $app ([NativeWindowFixture]::Windows($app.Id)[0])
    [NativeWindowFixture]::Click($handle, 75, 290)
    [NativeWindowFixture]::Click($handle, 266, 235)
    Wait-For 'remove Launch at login' { -not (Test-Path $startup) }
    [NativeWindowFixture]::Click($handle, 266, 267)
    Wait-For 'save Start hidden off' { Saved 'window' 'startHidden' $false }
    Request-Quit
    Wait-For 'quit after changing login preferences' { $app.Refresh(); $app.HasExited }
    $app = Start-Process -FilePath $appExe -ArgumentList '--login' -PassThru
    Wait-For 'show the window at login with Start hidden off' { [NativeWindowFixture]::Windows($app.Id).Length -eq 1 }
    'Changes made through installed Settings survived Quit. Windows Startup, both title bars, the global shortcut, and Acrylic/Mica applied in the installed app.' |
        Set-Content (Join-Path $out 'settings-assertions.txt')
} finally {
    if ($app -and -not $app.HasExited) {
        try { Request-Quit; [void]$app.WaitForExit(15000) } catch { Write-Warning $_.Exception.Message }
    }
    Move-Item -Force "$index.evidence-original" $index
}
