# Runs only on the interactive Windows runner. This driver is not part of Setup.
param([int]$AppId, [string]$Operation, [string]$Title, [string]$First, [string]$Second)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DesktopInput {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    delegate bool Visitor(IntPtr h, IntPtr ignored);
    [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visit, IntPtr ignored);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr a, IntPtr b);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    public static IntPtr Find(int app, string title) {
        IntPtr window = IntPtr.Zero;
        EnumWindows(delegate(IntPtr current, IntPtr ignored) {
            int owner;
            GetWindowThreadProcessId(current, out owner);
            if (owner != app || !IsWindowVisible(current)) return true;
            StringBuilder name = new StringBuilder(256);
            GetWindowText(current, name, name.Capacity);
            if (name.ToString() != title) return true;
            window = current;
            return false;
        }, IntPtr.Zero);
        return window;
    }
}
'@

for ($try = 0; $try -lt 60; $try++) {
    $window = [DesktopInput]::Find($AppId, $Title)
    if ($window -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 300
}
if ($window -eq [IntPtr]::Zero) { throw "The installed app did not show '$Title'" }
if ($Operation -eq 'find') { return }
[DesktopInput]::SetForegroundWindow($window) | Out-Null
Start-Sleep -Milliseconds 180
switch ($Operation) {
    shot {
        $rect = New-Object DesktopInput+Rect
        if (-not [DesktopInput]::GetWindowRect($window, [ref]$rect)) { throw 'Cannot measure the installed window' }
        $bounds = [System.Drawing.Rectangle]::FromLTRB($rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
        $bounds = [System.Drawing.Rectangle]::Intersect($bounds, [System.Windows.Forms.SystemInformation]::VirtualScreen)
        $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
            $bitmap.Save($First, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
    click {
        $point = New-Object DesktopInput+Point
        $scale = [DesktopInput]::GetDpiForWindow($window) / 96
        $point.X = [int]([int]$First * $scale)
        $point.Y = [int]([int]$Second * $scale)
        if (-not [DesktopInput]::ClientToScreen($window, [ref]$point)) { throw 'Cannot map the pointer to the window' }
        if (-not [DesktopInput]::SetCursorPos($point.X, $point.Y)) { throw 'Cannot move the pointer' }
        [DesktopInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        [DesktopInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    }
    key {
        $key = @{ Tab = '{TAB}'; Space = ' '; Enter = '{ENTER}' }[$First]
        [System.Windows.Forms.SendKeys]::SendWait($key)
    }
    type { [System.Windows.Forms.SendKeys]::SendWait($First) }
    close {
        if (-not [DesktopInput]::PostMessage($window, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero)) { throw 'Cannot close the window' }
    }
    default { throw "Unknown test operation: $Operation" }
}
Start-Sleep -Milliseconds 250
