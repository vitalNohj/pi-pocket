// This driver runs on the interactive Windows installer runner. It is not shipped with the app.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

static class WindowInput
{
    [StructLayout(LayoutKind.Sequential)]
    struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct NotifyIconIdentifier { public uint Size; public IntPtr Window; public uint Id; public Guid Guid; }
    delegate bool Visitor(IntPtr window, IntPtr ignored);

    [DllImport("shell32.dll")] static extern int Shell_NotifyIconGetRect(ref NotifyIconIdentifier icon, out Rect rect);
    [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visit, IntPtr ignored);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr first, IntPtr second);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string kind, string title);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            if (args[0] == "launch")
            {
                using (Process app = Process.Start(new ProcessStartInfo(args[1]) { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Normal }))
                {
                    Console.WriteLine(app.Id);
                }
                return 0;
            }

            SetProcessDpiAwarenessContext(new IntPtr(-4)); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            int pid = int.Parse(args[0], CultureInfo.InvariantCulture);
            string operation = args[1];
            if (operation == "tray-shot")
            {
                RunnerTray(pid, args[2], args[3]);
                return 0;
            }
            IntPtr window = WaitForWindow(pid, args[2]);
            if (operation == "find") { return 0; }
            if (operation == "close")
            {
                if (!PostMessage(window, 0x0112, new IntPtr(0xF060), IntPtr.Zero))
                {
                    throw new InvalidOperationException("Cannot close the installed window.");
                }
                return 0;
            }

            SetForegroundWindow(window);
            Thread.Sleep(180);
            if (GetForegroundWindow() != window) { throw new InvalidOperationException("The installed window is not in the foreground."); }

            switch (operation)
            {
                case "expect-field": WaitForFocusedField(window, args[3]); break;
                case "expect-text": WaitForNamed(() => Named(AutomationElement.FromHandle(window), args[3]), args[3]); break;
                case "press": ClickElement(WaitForNamed(() => Named(AutomationElement.FromHandle(window), args[3]), args[3]), false); break;
                case "shot": Screenshot(window, args[3]); break;
                case "dictation-menu": DictationMenu(pid, window, args[3]); break;
                case "click": Click(window, int.Parse(args[3], CultureInfo.InvariantCulture), int.Parse(args[4], CultureInfo.InvariantCulture)); break;
                case "type": SendKeys.SendWait(args[3]); break;
                case "type-private":
                    string code = Console.ReadLine();
                    if (code == null || !System.Text.RegularExpressions.Regex.IsMatch(code, "^[A-Z0-9]{4}(-[A-Z0-9]{4}){2}$"))
                    {
                        throw new ArgumentException("Expected a disposable code on stdin.");
                    }
                    SendKeys.SendWait(code);
                    break;
                default: throw new ArgumentException("Unknown test operation.");
            }
            Thread.Sleep(250);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    static AutomationElement Named(AutomationElement root, string name)
    {
        return root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, name));
    }

    static AutomationElement WaitForNamed(Func<AutomationElement> find, string name)
    {
        Stopwatch wait = Stopwatch.StartNew();
        while (wait.Elapsed.TotalSeconds < 15)
        {
            try
            {
                AutomationElement item = find();
                if (item != null && !item.Current.IsOffscreen) { return item; }
            }
            catch (ElementNotAvailableException) { }
            Thread.Sleep(200);
        }
        throw new InvalidOperationException("Could not see '" + name + "' in the installed app or notification area.");
    }

    static void ClickElement(AutomationElement item, bool right)
    {
        System.Windows.Point point;
        if (!item.TryGetClickablePoint(out point)) { throw new InvalidOperationException("The control cannot be clicked."); }
        if (!SetCursorPos((int)point.X, (int)point.Y)) { throw new InvalidOperationException("Cannot move the pointer to the control."); }
        mouse_event(right ? 8u : 2u, 0, 0, 0, UIntPtr.Zero);
        mouse_event(right ? 16u : 4u, 0, 0, 0, UIntPtr.Zero);
    }

    static AutomationElement VisibleIcon()
    {
        foreach (string kind in new[] { "Shell_TrayWnd", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland" })
        {
            IntPtr window = FindWindow(kind, null);
            if (window == IntPtr.Zero || !IsWindowVisible(window)) { continue; }
            var icon = Named(AutomationElement.FromHandle(window), "Pi Pocket");
            if (icon != null && !icon.Current.IsOffscreen) { return icon; }
        }
        return null;
    }

    static void FocusNotificationArea()
    {
        // Win+B focuses the notification area without using the overflow button's localized name.
        var taskbar = FindWindow("Shell_TrayWnd", null);
        if (taskbar == IntPtr.Zero) { return; }
        int explorer;
        GetWindowThreadProcessId(taskbar, out explorer);
        keybd_event(0x5B, 0, 1, UIntPtr.Zero); // VK_LWIN, extended key
        keybd_event(0x42, 0, 0, UIntPtr.Zero); // B
        keybd_event(0x42, 0, 2, UIntPtr.Zero); // KEYEVENTF_KEYUP
        keybd_event(0x5B, 0, 3, UIntPtr.Zero);
        Thread.Sleep(400);
        var focused = AutomationElement.FocusedElement;
        if (VisibleIcon() == null && focused != null && focused.Current.ProcessId == explorer)
        {
            SendKeys.SendWait("{ENTER}");
            Thread.Sleep(600);
        }
    }

    static bool OpenRegisteredTrayMenu(int pid)
    {
        // Some Explorer versions do not expose the overflow icons through UI Automation. Locate the
        // installed app's registered WinForms NotifyIcon (the first icon in this process) by HWND and ID.
        // Then send its normal right-click callback. This neither builds a menu nor uses a test hook in the app.
        bool opened = false;
        EnumWindows(delegate(IntPtr window, IntPtr ignored)
        {
            int owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != pid) { return true; }
            var icon = new NotifyIconIdentifier { Size = (uint)Marshal.SizeOf(typeof(NotifyIconIdentifier)), Window = window, Id = 1 };
            Rect rect;
            if (Shell_NotifyIconGetRect(ref icon, out rect) < 0 || rect.Right <= rect.Left) { return true; }
            SetCursorPos((rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2);
            opened = PostMessage(window, 0x0800, new IntPtr(1), new IntPtr(0x0205)); // WM_TRAYMOUSEMESSAGE, WM_RBUTTONUP
            return false;
        }, IntPtr.Zero);
        return opened;
    }

    static void RunnerTray(int pid, string label, string path)
    {
        var icon = VisibleIcon();
        if (icon == null)
        {
            FocusNotificationArea();
            icon = VisibleIcon();
        }
        if (icon != null) { ClickElement(icon, true); }
        else if (!OpenRegisteredTrayMenu(pid)) { throw new InvalidOperationException("The installed app has no accessible or registered tray icon."); }

        IntPtr menu = IntPtr.Zero;
        var row = WaitForNamed(() =>
        {
            AutomationElement result = null;
            EnumWindows(delegate(IntPtr window, IntPtr ignored)
            {
                int owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner != pid || !IsWindowVisible(window)) { return true; }
                result = Named(AutomationElement.FromHandle(window), label);
                if (result == null || result.Current.IsOffscreen) { return true; }
                menu = window;
                return false;
            }, IntPtr.Zero);
            return menu == IntPtr.Zero ? null : result;
        }, label);
        Screenshot(menu, path);
        // Activate the exact native row that appears in the screenshot.
        ClickElement(row, false);
    }

    static void WaitForFocusedField(IntPtr window, string expected)
    {
        // Poll observations only. Do not post more input or change the field.
        Stopwatch wait = Stopwatch.StartNew();
        while (wait.Elapsed.TotalSeconds < 5)
        {
            try
            {
                AutomationElement field = AutomationElement.FocusedElement;
                object pattern;
                if (GetForegroundWindow() == window && field != null &&
                    field.Current.ControlType == ControlType.Edit &&
                    field.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) &&
                    ((ValuePattern)pattern).Current.Value == expected) { return; }
            }
            catch (ElementNotAvailableException) { } // The WebView can replace an accessibility node while rendering.
            Thread.Sleep(100);
        }
        throw new InvalidOperationException("The focused Server address field did not contain the fixture address.");
    }

    static IntPtr WaitForWindow(int pid, string title)
    {
        using (Process app = Process.GetProcessById(pid))
        {
            Stopwatch wait = Stopwatch.StartNew();
            while (wait.Elapsed.TotalSeconds < 20 && !app.HasExited)
            {
                IntPtr result = IntPtr.Zero;
                EnumWindows(delegate(IntPtr window, IntPtr ignored)
                {
                    int owner;
                    GetWindowThreadProcessId(window, out owner);
                    if (owner != pid || !IsWindowVisible(window)) { return true; }
                    var caption = new StringBuilder(256);
                    GetWindowText(window, caption, caption.Capacity);
                    if (caption.ToString() != title) { return true; }
                    result = window;
                    return false;
                }, IntPtr.Zero);
                if (result != IntPtr.Zero) { return result; }
                Thread.Sleep(250);
            }
            app.Refresh();
            string main = app.HasExited ? "app exited" : "main window: '" + app.MainWindowTitle + "'";
            throw new InvalidOperationException("The installed app did not show '" + title + "' (" + main + ").");
        }
    }

    static void Click(IntPtr window, int x, int y)
    {
        double scale = GetDpiForWindow(window) / 96.0;
        var point = new Point { X = (int)Math.Round(x * scale), Y = (int)Math.Round(y * scale) };
        if (!ClientToScreen(window, ref point) || !SetCursorPos(point.X, point.Y))
        {
            throw new InvalidOperationException("Cannot move the pointer to the installed window.");
        }
        mouse_event(2, 0, 0, 0, UIntPtr.Zero);
        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
    }

    static HashSet<IntPtr> VisibleWindows(int pid)
    {
        var visible = new HashSet<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr ignored)
        {
            int owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner == pid && IsWindowVisible(window)) { visible.Add(window); }
            return true;
        }, IntPtr.Zero);
        return visible;
    }

    static void DictationMenu(int pid, IntPtr window, string path)
    {
        var before = VisibleWindows(pid);
        const int fixtureMenu = 0x8031; // Ask the isolated installed app to show its actual tray menu.
        if (!PostMessage(window, fixtureMenu, IntPtr.Zero, IntPtr.Zero))
        {
            throw new InvalidOperationException("Cannot ask the installed app to show the tray menu.");
        }

        Stopwatch wait = Stopwatch.StartNew();
        while (wait.Elapsed.TotalSeconds < 8)
        {
            var shown = VisibleWindows(pid);
            shown.ExceptWith(before);
            if (shown.Count != 0)
            {
                // Let the menu paint and verify that the popup stayed open for the screenshot.
                Thread.Sleep(250);
                shown.IntersectWith(VisibleWindows(pid));
                if (shown.Count != 0)
                {
                    Capture(SystemInformation.VirtualScreen, path);
                    SendKeys.SendWait("{ESC}");
                    return;
                }
            }
            Thread.Sleep(100);
        }
        throw new InvalidOperationException("The installed app did not show the dictation tray menu.");
    }

    static void Screenshot(IntPtr window, string path)
    {
        Rect rect;
        if (!GetWindowRect(window, out rect)) { throw new InvalidOperationException("Cannot measure the installed window."); }
        Rectangle bounds = Rectangle.Intersect(Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom), SystemInformation.VirtualScreen);
        Capture(bounds, path);
    }

    static void Capture(Rectangle bounds, string path)
    {
        using (var image = new Bitmap(bounds.Width, bounds.Height))
        using (Graphics graphics = Graphics.FromImage(image))
        {
            graphics.CopyFromScreen(bounds.Location, System.Drawing.Point.Empty, bounds.Size);
            image.Save(path, ImageFormat.Png);
        }
    }
}
