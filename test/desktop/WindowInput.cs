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
    delegate bool Visitor(IntPtr window, IntPtr ignored);

    [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visit, IntPtr ignored);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int max);
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
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);

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
            if (operation == "tray")
            {
                Tray(pid, args[2], args[3], args[4], args[5], args[6]);
                return 0;
            }
            IntPtr window = WaitForWindow(pid, args[2]);
            if (operation == "find") { return 0; }
            if (operation == "close" || operation == "close-to-tray")
            {
                if (!PostMessage(window, 0x0112, new IntPtr(0xF060), IntPtr.Zero))
                {
                    throw new InvalidOperationException("Cannot close the installed window.");
                }
                if (operation == "close-to-tray")
                {
                    for (int i = 0; i < 25 && IsWindowVisible(window); i++) { Thread.Sleep(200); }
                    if (IsWindowVisible(window)) { throw new InvalidOperationException("The installed window did not hide to the tray."); }
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
                case "expect-prefix": WaitForNamed(() => WithPrefix(AutomationElement.FromHandle(window), args[3]), args[3]); break;
                case "press": ClickElement(WaitForNamed(() => Named(AutomationElement.FromHandle(window), args[3]), args[3])); break;
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
                case "new": SendKeys.SendWait("^n"); break;
                case "choose": SendKeys.SendWait(args[3] == "next" ? "{DOWN}{ENTER}" : "{END}{ENTER}"); break;
                case "selectAll": SendKeys.SendWait("^a"); break;
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

    static AutomationElement WithPrefix(AutomationElement root, string prefix)
    {
        foreach (AutomationElement item in root.FindAll(TreeScope.Descendants, Condition.TrueCondition))
        {
            if (!item.Current.IsOffscreen && item.Current.Name.StartsWith(prefix, StringComparison.Ordinal)) { return item; }
        }
        return null;
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

    static void ClickElement(AutomationElement item)
    {
        System.Windows.Point point;
        if (!item.TryGetClickablePoint(out point)) { throw new InvalidOperationException("The control cannot be clicked."); }
        if (!SetCursorPos((int)point.X, (int)point.Y)) { throw new InvalidOperationException("Cannot move the pointer to the control."); }
        mouse_event(2, 0, 0, 0, UIntPtr.Zero);
        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
    }

    static AutomationElement FindUI(int pid, string text, bool exact)
    {
        AutomationElement result = null;
        EnumWindows(delegate(IntPtr window, IntPtr ignored)
        {
            if (!IsWindowVisible(window)) { return true; }
            if (pid != 0)
            {
                int owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner != pid) { return true; }
            }
            else
            {
                var name = new StringBuilder(128);
                GetClassName(window, name, name.Capacity);
                switch (name.ToString())
                {
                    case "Shell_TrayWnd":
                    case "Shell_SecondaryTrayWnd":
                    case "TopLevelWindowForOverflowXamlIsland":
                    case "NotifyIconOverflowWindow":
                        break;
                    default: return true;
                }
            }
            try
            {
                AutomationElement root = AutomationElement.FromHandle(window);
                if (root == null) { return true; }
                foreach (AutomationElement element in root.FindAll(TreeScope.Subtree,
                    new PropertyCondition(AutomationElement.IsOffscreenProperty, false)))
                {
                    string name = element.Current.Name;
                    bool matches = exact ? name == text : name.IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0;
                    if (matches && !element.Current.BoundingRectangle.IsEmpty)
                    {
                        result = element;
                        return false;
                    }
                }
            }
            catch (ElementNotAvailableException) { }
            catch (COMException) { }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    static AutomationElement WaitForUI(int pid, string text, bool exact = false)
    {
        for (int i = 0; i < 20; i++)
        {
            AutomationElement element = FindUI(pid, text, exact);
            if (element != null) { return element; }
            Thread.Sleep(200);
        }
        throw new InvalidOperationException("The tray did not show '" + text + "'.");
    }

    static void PointAt(AutomationElement element, uint down = 0)
    {
        var rect = element.Current.BoundingRectangle;
        if (!SetCursorPos((int)(rect.Left + rect.Width / 2), (int)(rect.Top + rect.Height / 2)))
        {
            throw new InvalidOperationException("Cannot move the pointer to the tray item.");
        }
        if (down != 0)
        {
            mouse_event(down, 0, 0, 0, UIntPtr.Zero);
            mouse_event(down * 2, 0, 0, 0, UIntPtr.Zero);
        }
    }

    static void RunnerTray(int pid, string label, string path)
    {
        // Open the installed app's real notification icon, including when Explorer hides it in overflow.
        var icon = FindUI(0, "Pi Pocket", false);
        if (icon == null)
        {
            PointAt(WaitForUI(0, "Show hidden icons"), 2);
            icon = WaitForUI(0, "Pi Pocket");
        }
        PointAt(icon, 8);
        WaitForUI(pid, "Open Pi Pocket", exact: true);
        var row = WaitForUI(pid, label, exact: true);
        Capture(SystemInformation.VirtualScreen, path);
        PointAt(row, 2);
        Thread.Sleep(250);
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

    static void Tray(int pid, string badge, string submenu, string select, string proof, string other)
    {
        // Use Explorer's real icon (which may be under the overflow chevron), not app IPC.
        string label = "Pi Pocket (" + badge + ")";
        AutomationElement icon = FindUI(0, label, false);
        if (icon == null)
        {
            PointAt(WaitForUI(0, "Show hidden icons"), 2);
            icon = WaitForUI(0, label);
        }
        PointAt(icon, 8);
        try
        {
            WaitForUI(pid, "Open " + label);
            if (submenu != "-") { PointAt(WaitForUI(pid, submenu)); }
            if (other != "-") { WaitForUI(pid, other); }
            AutomationElement item = WaitForUI(pid, select);
            if (proof != "-") { Capture(SystemInformation.VirtualScreen, proof); }
            PointAt(item, 2);
            Thread.Sleep(250);
        }
        catch
        {
            if (proof != "-") { Capture(SystemInformation.VirtualScreen, proof); }
            throw;
        }
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
