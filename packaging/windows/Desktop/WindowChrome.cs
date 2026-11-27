using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace PiPocket
{
    sealed partial class PocketWindow
    {
        readonly string windowKey = Guid.NewGuid().ToString("N");
        WindowDownloads downloads;
        bool pageChrome, seamless, translucent, fullScreen;
        Rectangle caption;
        Rectangle restoredBounds;
        FormWindowState restoredState;
        Region viewClip;
        string lastGeometry;
        Color? desk, panel, text;
        bool dark;
        internal string EffectStatus { get; private set; }

        async System.Threading.Tasks.Task InitializeChrome(CoreWebView2Environment environment)
        {
            downloads = new WindowDownloads(this, origin, host.DownloadNotice);
            Browser.DownloadStarting += downloads.Start;
            WindowContextMenu.Add(Browser, environment, origin, ShowWindowOptions);
            view.ZoomFactorChanged += delegate { LayoutChrome(); };
            Browser.Settings.IsZoomControlEnabled = true;
            ApplyWindowPreferences();

            if (!bridgeEnabled) { return; }
            Browser.WebMessageReceived += ReceiveWindowMessage;
            // Embedded with the installer, not fetched or evaluated from the server.
            using (Stream code = typeof(PocketWindow).Assembly.GetManifestResourceStream("PiPocket.Window.js"))
            using (var reader = new StreamReader(code))
            {
                await Browser.AddScriptToExecuteOnDocumentCreatedAsync(reader.ReadToEnd().Trim().TrimEnd(';') + "(" + json.Serialize(origin) +
                    "," + json.Serialize(windowKey) + "," + GeometryJson() +
                    ", (message) => window.chrome.webview.postMessage(message));");
            }
        }

        void ReceiveWindowMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            // This listener owns only the window script. Page bridge messages use a different key and handler.
            if (!committed || generation != host.PageGeneration || IsDisposed || Disposing ||
                !IsServerAddress(args.Source, origin) || !IsServerAddress(Browser.Source, origin)) { return; }
            Dictionary<string, object> message;
            try { message = json.Deserialize<Dictionary<string, object>>(args.WebMessageAsJson); }
            catch (ArgumentException) { return; }
            catch (InvalidOperationException) { return; }
            if (message == null || BridgeProtocol.Text(message, "key", 32) != windowKey) { return; }
            WindowMessage(BridgeProtocol.Text(message, "type", 16), message);
        }

        void ResetWindowPage()
        {
            if (!pageChrome) { return; }
            pageChrome = false;
            lastGeometry = null;
            LayoutChrome();
        }

        internal void ApplyWindowPreferences()
        {
            if (Browser != null) { Browser.Settings.AreDevToolsEnabled = host.NativeDeveloperTools; }
            LayoutChrome();
        }

        void ApplyPalette(System.Collections.Generic.Dictionary<string, object> message)
        {
            Color? newDesk = ReadColor(BridgeProtocol.Text(message, "background", 7));
            Color? newPanel = ReadColor(BridgeProtocol.Text(message, "panel", 7));
            Color? newText = ReadColor(BridgeProtocol.Text(message, "text", 7));
            object mode;
            if (!newDesk.HasValue || !newPanel.HasValue || !newText.HasValue || !message.TryGetValue("dark", out mode) || !(mode is bool)) { return; }
            desk = newDesk;
            panel = newPanel;
            text = newText;
            dark = (bool)mode;
            host.ReportWindowTheme(this, new {
                dark = dark,
                background = BridgeProtocol.Text(message, "background", 7),
                panel = BridgeProtocol.Text(message, "panel", 7),
                text = BridgeProtocol.Text(message, "text", 7),
                accent = BridgeProtocol.Text(message, "accent", 7),
            });
            LayoutChrome();
        }

        internal static Color? ReadColor(string value)
        {
            int rgb;
            if (value == null || value.Length != 7 || value[0] != '#' || !int.TryParse(value.Substring(1),
                System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out rgb)) { return null; }
            return Color.FromArgb(unchecked((int)0xff000000) | rgb);
        }

        void WindowMessage(string type, System.Collections.Generic.Dictionary<string, object> message)
        {
            switch (type)
            {
                case "ready":
                    pageChrome = true;
                    lastGeometry = null;
                    LayoutChrome();
                    break;
                case "theme":
                    if (pageChrome) { ApplyPalette(message); }
                    break;
                case "download-link":
                    if (pageChrome) { downloads.LinkActivated(BridgeProtocol.Text(message, "url", 8192)); }
                    break;
                case "drag":
                    if (pageChrome && seamless) { DragFromPage(message); }
                    break;
                case "context":
                    // WebView2 supplies the page's normal context menu, including the app item.
                    break;
            }
        }

        string GeometryJson()
        {
            double scale = Dpi / 96.0 * (Browser == null ? 1 : view.ZoomFactor);
            bool overlay = seamless && !caption.IsEmpty && !desktopMenu.Visible && !shellStrip.Visible;
            return json.Serialize(new {
                side = overlay ? "right" : "none",
                width = overlay ? Math.Ceiling((ClientSize.Width - caption.Left) / scale) : 0,
                height = overlay ? Math.Ceiling(caption.Bottom / scale) : 0,
                tint = translucent ? (int?)host.WindowPrefs.opacity : null,
            });
        }

        int Dpi { get { return IsHandleCreated ? Math.Max(96, (int)GetDpiForWindow(Handle)) : 96; } }

        void LayoutChrome()
        {
            if (!IsHandleCreated || IsDisposed || Disposing || desktopMenu == null) { return; }
            bool next = !fullScreen && host.WindowPrefs.titleBar == "seamless" && !SystemInformation.HighContrast &&
                DwmIsCompositionEnabled(out composition) == 0 && composition;
            if (next != seamless)
            {
                seamless = next;
                SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, FrameChanged);
            }

            caption = seamless ? CaptionBounds() : Rectangle.Empty;
            bool accessible = SystemInformation.HighContrast;
            int immersive = !accessible && dark ? 1 : 0;
            if (DwmSetWindowAttribute(Handle, 20, ref immersive, 4) != 0) { DwmSetWindowAttribute(Handle, 19, ref immersive, 4); }
            bool allowsTransparency = AllowsTransparency();
            int backdrop = pageChrome && host.WindowPrefs.seeThrough && !fullScreen && allowsTransparency
                ? (host.WindowPrefs.material == "mica" ? 2 : 3) : 1; // DWMSBT_MAINWINDOW / TRANSIENTWINDOW
            var margins = backdrop == 1 ? new Margins { Top = FrameExtension } : new Margins { Top = -1 };
            int glass = DwmExtendFrameIntoClientArea(Handle, ref margins);
            int result = DwmSetWindowAttribute(Handle, 38, ref backdrop, 4);
            translucent = backdrop != 1 && glass == 0 && result == 0;
            if (backdrop != 1 && !translucent)
            {
                margins.Top = FrameExtension;
                DwmExtendFrameIntoClientArea(Handle, ref margins);
            }
            EffectStatus = !allowsTransparency || backdrop != 1 && !translucent ? "unsupported" :
                fullScreen ? "full-screen" : pageChrome ? "available" : "page";
            host.ReportWindowEffect(this, EffectStatus);

            Color? frame = seamless && pageChrome ? desk : panel;
            int background = !translucent && !accessible && frame.HasValue ? ColorRef(frame.Value) : -1;
            int foreground = !accessible && text.HasValue ? ColorRef(text.Value) : -1;
            DwmSetWindowAttribute(Handle, 35, ref background, 4); // DWMWA_CAPTION_COLOR, Win11
            DwmSetWindowAttribute(Handle, 36, ref foreground, 4);
            Color surface = !accessible ? frame ?? SystemColors.Window : SystemColors.Window;
            // Black in the extended area lets DWM paint the window buttons over the custom frame.
            BackColor = translucent || seamless ? Color.Black : surface;
            view.DefaultBackgroundColor = translucent ? Color.Transparent : surface;
            bool showMenu = !fullScreen && (host.NativeShowMenuBar || altMenu);
            bool showNotice = !fullScreen && remoteNotice.Text.Length > 0;
            desktopMenu.Visible = showMenu;
            shellStrip.Visible = showNotice;
            int top = !pageChrome || showMenu || showNotice ? Math.Max(0, caption.Bottom) : 0;
            if (showMenu)
            {
                desktopMenu.SetBounds(0, top, ClientSize.Width, desktopMenu.PreferredSize.Height);
                top += desktopMenu.Height;
            }
            if (showNotice)
            {
                shellStrip.SetBounds(0, top, ClientSize.Width, shellStrip.PreferredSize.Height);
                top += shellStrip.Height;
            }
            view.SetBounds(0, top, ClientSize.Width, Math.Max(0, ClientSize.Height - top));

            // A child HWND would otherwise cover (and receive input over) the OS-owned caption buttons.
            Region clip = null;
            if (top == 0 && seamless)
            {
                clip = new Region(view.ClientRectangle);
                clip.Exclude(caption);
                if (!IsZoomed(Handle))
                {
                    // This narrow strip belongs to the native top resize handle, not to the child window.
                    clip.Exclude(new Rectangle(0, 0, view.Width, TopResize));
                }
            }
            view.Region = clip;
            if (viewClip != null) { viewClip.Dispose(); }
            viewClip = clip;
            Invalidate();

            if (pageChrome && Browser != null)
            {
                string state = GeometryJson();
                if (state != lastGeometry)
                {
                    lastGeometry = state;
                    SendGeometry(state);
                }
            }
        }

        bool composition;
        internal bool IsForeground { get { return IsHandleCreated && GetForegroundWindow() == Handle; } }

        async void SendGeometry(string state)
        {
            try { await Browser.ExecuteScriptAsync("window.__piPocketWindow?.update(" + state + ")"); }
            catch (InvalidOperationException) { /* The view is closing. */ }
            catch (COMException) { /* A document was replaced. */ }
        }

        static int ColorRef(Color color) { return color.R | color.G << 8 | color.B << 16; }

        internal static bool AllowsTransparency()
        {
            if (Environment.OSVersion.Version.Build < 22621 || SystemInformation.HighContrast) { return false; }
            bool enabled;
            if (DwmIsCompositionEnabled(out enabled) != 0 || !enabled) { return false; }

            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            {
                return key == null || !Equals(key.GetValue("EnableTransparency"), 0);
            }
        }

        int FrameExtension { get { return seamless ? Math.Max(caption.Bottom, GetSystemMetricsForDpi(4, (uint)Dpi) + FrameThickness(33)) : 0; } }
        int FrameThickness(int metric) { return GetSystemMetricsForDpi(metric, (uint)Dpi) + GetSystemMetricsForDpi(92, (uint)Dpi); }
        int TopResize { get { return Math.Max(1, Dpi / 32); } }

        Rectangle CaptionBounds()
        {
            Rect bounds, window;
            if (DwmGetWindowAttribute(Handle, 5, out bounds, Marshal.SizeOf(typeof(Rect))) == 0 &&
                bounds.Right > bounds.Left && GetWindowRect(Handle, out window))
            {
                Point top = PointToClient(new Point(window.Left + bounds.Left, window.Top + bounds.Top));
                return Rectangle.FromLTRB(Math.Max(0, top.X), 0, ClientSize.Width, Math.Max(1, top.Y + bounds.Bottom - bounds.Top));
            }

            int dpi = Dpi;
            int width = GetSystemMetricsForDpi(30, (uint)dpi) * 3;
            return new Rectangle(Math.Max(0, ClientSize.Width - width), 0, width, GetSystemMetricsForDpi(4, (uint)dpi));
        }

        void DragFromPage(System.Collections.Generic.Dictionary<string, object> message)
        {
            object x, y, count;
            if (!message.TryGetValue("x", out x) || !(x is int) || !message.TryGetValue("y", out y) || !(y is int) ||
                !message.TryGetValue("clicks", out count) || !(count is int) || GetForegroundWindow() != Handle || GetAsyncKeyState(1) >= 0) { return; }
            double scale = Dpi / 96.0 * view.ZoomFactor;
            Point point = view.PointToClient(Cursor.Position);
            if (Math.Abs(point.X - (int)x * scale) > 24 || Math.Abs(point.Y - (int)y * scale) > 24) { return; }
            BeginInvoke((MethodInvoker)delegate
            {
                if (IsDisposed || !seamless || GetAsyncKeyState(1) >= 0) { return; }
                Point p = Cursor.Position;
                ReleaseCapture();
                SendMessage(Handle, (int)count == 2 ? 0x00A3 : 0x00A1, new IntPtr(2),
                    new IntPtr((p.X & 0xffff) | ((p.Y & 0xffff) << 16)));
            });
        }

        bool HandleChrome(ref Message message)
        {
            if (!seamless) { return false; }
            IntPtr result;
            bool handled = DwmDefWindowProc(message.HWnd, message.Msg, message.WParam, message.LParam, out result);
            if (message.Msg == 0x0083 && message.WParam != IntPtr.Zero) // WM_NCCALCSIZE
            {
                // Use the window's own rectangle, not DefWindowProc's caption-inset rectangle. DWM draws its buttons
                // in the extended frame. Keep the side and bottom sizing borders and the invisible maximized inset.
                Rect client = (Rect)Marshal.PtrToStructure(message.LParam, typeof(Rect));
                int horizontal = FrameThickness(32);
                int vertical = FrameThickness(33);
                client.Left += horizontal;
                client.Right -= horizontal;
                client.Bottom -= vertical;
                if (IsZoomed(message.HWnd)) { client.Top += vertical; }
                Marshal.StructureToPtr(client, message.LParam, false);
                message.Result = IntPtr.Zero;
                return true;
            }
            if (handled)
            {
                message.Result = result;
                return true;
            }
            if (message.Msg == 0x0084) // WM_NCHITTEST
            {
                Point p = PointToClient(new Point(unchecked((short)message.LParam.ToInt64()),
                    unchecked((short)(message.LParam.ToInt64() >> 16))));
                if (p.Y >= 0 && p.Y < TopResize && !IsZoomed(message.HWnd))
                {
                    int side = FrameThickness(32);
                    message.Result = new IntPtr(p.X < side ? 13 : p.X >= ClientSize.Width - side ? 14 : 12);
                    return true;
                }
                if (p.Y >= 0 && p.Y < view.Top && !caption.Contains(p))
                {
                    message.Result = new IntPtr(2); // native fallback band (HTCAPTION)
                    return true;
                }
            }
            return false;
        }

        public void ToggleFullScreen()
        {
            if (!fullScreen)
            {
                restoredBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                restoredState = WindowState;
                fullScreen = true;
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.None;
                Bounds = Screen.FromHandle(Handle).Bounds;
            }
            else
            {
                fullScreen = false;
                FormBorderStyle = FormBorderStyle.Sizable;
                Bounds = restoredBounds;
                WindowState = restoredState;
            }
            LayoutChrome();
        }

        const uint FrameChanged = 0x0037; // SWP_FRAMECHANGED | NOMOVE | NOSIZE | NOZORDER | NOACTIVATE
        [StructLayout(LayoutKind.Sequential)] struct Margins { public int Left, Right, Top, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index, uint dpi);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wp, IntPtr lp);
        [DllImport("dwmapi.dll")] static extern int DwmIsCompositionEnabled(out bool enabled);
        [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int index, ref int value, int size);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int index, out Rect rect, int size);
        [DllImport("dwmapi.dll")] static extern bool DwmDefWindowProc(IntPtr hwnd, int msg, IntPtr wp, IntPtr lp, out IntPtr result);
    }
}
