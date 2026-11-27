// This driver runs on the interactive Windows installer runner. It is not shipped with the app.
using System;
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
                case "shot": Screenshot(window, args[3]); break;
                case "click": Click(window, int.Parse(args[3], CultureInfo.InvariantCulture), int.Parse(args[4], CultureInfo.InvariantCulture)); break;
                case "type": SendKeys.SendWait(args[3]); break;
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

    static void Screenshot(IntPtr window, string path)
    {
        Rect rect;
        if (!GetWindowRect(window, out rect)) { throw new InvalidOperationException("Cannot measure the installed window."); }
        Rectangle bounds = Rectangle.Intersect(Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom), SystemInformation.VirtualScreen);
        using (var image = new Bitmap(bounds.Width, bounds.Height))
        using (Graphics graphics = Graphics.FromImage(image))
        {
            graphics.CopyFromScreen(bounds.Location, System.Drawing.Point.Empty, bounds.Size);
            image.Save(path, ImageFormat.Png);
        }
    }
}
