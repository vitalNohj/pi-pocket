// The Windows web view and version 1 app bridge (docs/embedders.md). The tray owns the window, not the other way round.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PiPocket
{
    sealed partial class PocketWindow : Form
    {
        readonly TrayApp host;
        readonly string origin;
        readonly string boundsFile;
        readonly string bridgeKey = Guid.NewGuid().ToString("N");
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 8 };
        readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill };
        bool committed;
        bool subscribed;
        bool newSessionEnabled;
        bool pendingNewSession;
        bool recovered;
        readonly int generation;
        readonly bool bridge;
        readonly string[] allowed;
        bool? lastVisibility;
        string pendingAddress;

        public PocketWindow(TrayApp host, string origin, Icon icon, string boundsFile)
        {
            this.host = host;
            this.origin = origin;
            this.boundsFile = boundsFile;
            generation = host.PageGeneration;
            bridge = host.PageBridge;
            allowed = host.OtherOrigins;
            Text = "Pi Pocket";
            Icon = icon;
            MinimumSize = new Size(420, 400);
            Rectangle work = Screen.PrimaryScreen.WorkingArea;
            Size = new Size(Math.Min(1200, work.Width), Math.Min(820, work.Height));
            StartPosition = FormStartPosition.CenterScreen;
            RestoreSavedBounds();
            Controls.Add(view);
            AddDesktopMenus();
            VisibleChanged += delegate { PublishVisibility(); };
            Resize += delegate { PublishVisibility(); };
        }

        public CoreWebView2 Browser { get { return view.CoreWebView2; } }
        bool ShownToUser { get { return Visible && WindowState != FormWindowState.Minimized; } }

        public async Task Initialize(ShellWebProfile profile)
        {
            await host.InitializeWebView(view, profile);
            if (IsDisposed) { return; }
            CoreWebView2 core = Browser;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = host.DeveloperTools;
            core.WebMessageReceived += Receive;
            core.NavigationStarting += Navigate;
            core.ContentLoading += delegate (object sender, CoreWebView2ContentLoadingEventArgs args)
            {
                if (args.NavigationId != navigation) { return; }
                committed = !args.IsErrorPage && IsServerAddress(core.Source, origin);
                host.ReportPage(this, committed ? origin : null);
                ShowPageNotice(!bridge || !committed ? "Sign in on this page to use Pi Pocket" : null);
            };
            core.NavigationCompleted += delegate (object sender, CoreWebView2NavigationCompletedEventArgs args)
            {
                if (args.NavigationId != navigation) { return; }
                if (args.IsSuccess) { recovered = false; }
                else if (args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) { ShowPageNotice("Could not load this server. Check the address or try again."); }
            };
            core.ProcessFailed += delegate (object sender, CoreWebView2ProcessFailedEventArgs args)
            {
                host.ReportPage(this, committed ? origin : null, true);
                if (!recovered && args.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
                {
                    recovered = true;
                    core.Reload();
                }
                else { ShowPageNotice("The page is not responding. Reload it or return to Home."); }
            };
            core.NewWindowRequested += host.NewWindowRequested;
            core.WindowCloseRequested += delegate { BeginInvoke((MethodInvoker)Close); };

            if (boundsFile != null && bridge)
            {
                core.WebResourceResponseReceived += CheckSignIn;
            }

            if (bridge) { await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript()); }
        }

        /// Check the URL as well as the effective origin. A sandboxed document can have a Pi Pocket URL and an opaque origin.
        string BridgeScript()
        {
            return @"(() => {
    const origin = " + json.Serialize(origin) + @";
    if (window.top !== window || window.origin !== origin || location.origin !== origin ||
        (location.protocol !== 'http:' && location.protocol !== 'https:')) { return; }
    const key = " + json.Serialize(bridgeKey) + @";
    const webview = window.chrome.webview;
    const post = (message) => webview.postMessage({ ...message, key });
    let listener = null;
    let shown = " + (ShownToUser ? "true" : "false") + @";
    webview.addEventListener('message', ({ data }) => {
        if (data.type === 'visibility') { shown = data.visible; }
        try { listener?.({ type: data.type, url: data.url }); } catch (error) { console.error(error); }
    });
    window.pocketHost = Object.freeze({
        kind: 'pi-pocket-windows',
        apiVersion: 1,
        capabilities: Object.freeze(['menu', 'badge', 'notify', 'visibility', 'open', 'newSession']),
        menuTitle: () => 'Pi Pocket Desktop',
        menuItems: () => [{ id: 'server-settings', label: 'Desktop Settings…' }],
        invoke: (id) => { if (id !== 'server-settings') { return false; } post({ type: 'settings' }); return true; },
        setBadge: (count) => post({ type: 'badge', count: Math.max(0, Math.min(2147483647, Math.floor(Number(count) || 0))) }),
        notify: (message) => post({
            type: 'notify',
            title: String(message?.title ?? 'Pi Pocket').slice(0, 63),
            body: String(message?.body ?? '').slice(0, 255),
            url: String(message?.url ?? '/').slice(0, 2048),
        }),
        visible: () => shown,
        subscribe: (next, events) => {
            listener = typeof next === 'function' ? next : null;
            if (listener) { post({ type: 'subscribe', newSession: Array.isArray(events) && events.includes('newSession') }); }
        },
    });
})();";
        }

        public static bool IsServerAddress(string address, string origin)
        {
            Uri uri;

            return Uri.TryCreate(address, UriKind.Absolute, out uri) &&
                (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps) && uri.UserInfo.Length == 0 &&
                string.Equals(uri.GetLeftPart(UriPartial.Authority), origin, StringComparison.OrdinalIgnoreCase);
        }

        ulong navigation;

        internal bool IsAppAddress(string address)
        {
            if (IsServerAddress(address, origin)) { return true; }
            Uri target;
            if (!Uri.TryCreate(address, UriKind.Absolute, out target) ||
                (origin.StartsWith("https:", StringComparison.Ordinal) && target.Scheme != "https")) { return false; }
            foreach (string allowedOrigin in allowed)
            {
                if (IsServerAddress(address, allowedOrigin)) { return true; }
            }
            return false;
        }

        void Navigate(object sender, CoreWebView2NavigationStartingEventArgs args)
        {
            Uri target, current;
            bool downgrade = Uri.TryCreate(Browser.Source, UriKind.Absolute, out current) && current.Scheme == "https" &&
                Uri.TryCreate(args.Uri, UriKind.Absolute, out target) && target.Scheme == "http";
            if (!IsAppAddress(args.Uri) || downgrade)
            {
                args.Cancel = true;
                if (args.IsUserInitiated && !args.IsRedirected) { host.OpenInDefaultBrowser(args.Uri); }
                else { ShowPageNotice("This sign-in address is not allowed. Review allowed origins under Server."); }
                return;
            }

            navigation = args.NavigationId;
            committed = subscribed = newSessionEnabled = false;
            lastVisibility = null;
        }

        void CheckSignIn(object sender, CoreWebView2WebResourceResponseReceivedEventArgs args)
        {
            // Observe the page's own request, with its own cookie, not a second sign-in made by the host.
            if (args.Request.Method == "GET" && args.Request.Uri == origin + "/api/me")
            {
                int status = args.Response.StatusCode;
                host.Log("The WebView2 window's /api/me answered " + status + ".");

                if (status == 200)
                {
                    Browser.WebResourceResponseReceived -= CheckSignIn;
                }
            }
        }

        void Receive(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            // CoreWebView2.WebMessageReceived is top-frame only; we do not handle CoreWebView2Frame messages.
            // Source is a URL, not an effective origin. Only the guarded document-start script gets the key.
            if (!bridge || !committed || generation != host.PageGeneration || IsDisposed || Disposing ||
                !IsServerAddress(args.Source, origin) || !IsServerAddress(Browser.Source, origin))
            {
                return;
            }

            Dictionary<string, object> message;

            try
            {
                message = json.Deserialize<Dictionary<string, object>>(args.WebMessageAsJson);
            }
            catch (ArgumentException)
            {
                return;
            }
            catch (InvalidOperationException)
            {
                return;
            }

            if (message == null || ReadText(message, "key", 32) != bridgeKey)
            {
                return;
            }

            switch (ReadText(message, "type", 12))
            {
                case "subscribe":
                    subscribed = true;
                    newSessionEnabled = ShellWire.Flag(message, "newSession");
                    lastVisibility = null;
                    PublishVisibility();
                    SendPendingAddress();
                    if (pendingNewSession) { NewSession(); }
                    break;

                case "settings":
                    host.ShellAction("settings.open");
                    break;

                case "badge":
                    object count;
                    if (message.TryGetValue("count", out count) && count is int && (int)count >= 0)
                    {
                        if (boundsFile != null)
                        {
                            host.SetBadge((int)count);
                            host.Report("badge", new { generation = generation, count = (int)count });
                        }
                    }
                    break;

                case "notify":
                    if (boundsFile != null)
                    {
                        host.Notify(ReadText(message, "title", 63) ?? "Pi Pocket", ReadText(message, "body", 255),
                            ReadText(message, "url", 2048) ?? "/");
                    }
                    break;
            }
        }

        static string ReadText(Dictionary<string, object> message, string name, int limit)
        {
            object value;
            string text = message.TryGetValue(name, out value) ? value as string : null;

            return text != null && text.Length <= limit ? text : null;
        }

        bool Post(object message)
        {
            if (!bridge || !committed || generation != host.PageGeneration || !subscribed || IsDisposed || Disposing || Browser == null || !IsServerAddress(Browser.Source, origin))
            {
                return false;
            }

            Browser.PostWebMessageAsJson(json.Serialize(message));
            return true;
        }

        void PublishVisibility()
        {
            bool visible = ShownToUser;
            if (boundsFile != null) { host.Report("visibility", visible); }

            if (lastVisibility != visible && Post(new { type = "visibility", visible = visible }))
            {
                lastVisibility = visible;
            }
        }

        public void NewSession()
        {
            pendingNewSession = !subscribed;
            if (newSessionEnabled) { Post(new { type = "newSession" }); }
        }

        public void OpenAddress(string address)
        {
            pendingAddress = address;
            SendPendingAddress();
        }

        void SendPendingAddress()
        {
            if (pendingAddress != null && Post(new { type = "open", url = pendingAddress }))
            {
                pendingAddress = null;
            }
        }

        public void ShowWindow()
        {
            Show();

            if (WindowState == FormWindowState.Minimized)
            {
                Native.ShowWindow(Handle, Native.SW_RESTORE);
            }

            Native.SetForegroundWindow(Handle);
        }

        protected override void OnFormClosing(FormClosingEventArgs args)
        {
            if (boundsFile != null && args.CloseReason == CloseReason.UserClosing)
            {
                SaveBounds();
                if (host.CloseToTray) { args.Cancel = true; Hide(); }
                else { host.MainClosed(); }
            }

            base.OnFormClosing(args);
        }

        void RestoreSavedBounds()
        {
            if (boundsFile == null || !File.Exists(boundsFile))
            {
                return;
            }

            try
            {
                string[] saved = File.ReadAllLines(boundsFile);
                int x, y, width, height;

                if (saved.Length != 5 || !int.TryParse(saved[0], out x) || !int.TryParse(saved[1], out y) ||
                    !int.TryParse(saved[2], out width) || !int.TryParse(saved[3], out height) || width < 1 || height < 1)
                {
                    return;
                }

                // Use the nearest screen, and make sure the window still fits when a screen was removed.
                Rectangle work = Screen.FromPoint(new Point(x, y)).WorkingArea;
                width = Math.Max(MinimumSize.Width, Math.Min(width, work.Width));
                height = Math.Max(MinimumSize.Height, Math.Min(height, work.Height));
                StartPosition = FormStartPosition.Manual;
                Bounds = new Rectangle(Math.Max(work.Left, Math.Min(x, work.Right - width)),
                    Math.Max(work.Top, Math.Min(y, work.Bottom - height)), width, height);

                if (saved[4] == "maximized")
                {
                    WindowState = FormWindowState.Maximized;
                }
            }
            catch (IOException)
            {
                // Start with the default bounds.
            }
            catch (UnauthorizedAccessException)
            {
                // Start with the default bounds.
            }
        }

        public void SaveBounds()
        {
            if (boundsFile == null)
            {
                return;
            }

            Rectangle bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;

            try
            {
                File.WriteAllLines(boundsFile, new[] {
                    bounds.X.ToString(CultureInfo.InvariantCulture), bounds.Y.ToString(CultureInfo.InvariantCulture),
                    bounds.Width.ToString(CultureInfo.InvariantCulture), bounds.Height.ToString(CultureInfo.InvariantCulture),
                    WindowState == FormWindowState.Maximized ? "maximized" : "normal",
                });
            }
            catch (IOException)
            {
                host.Log("Could not save the window bounds.");
            }
            catch (UnauthorizedAccessException)
            {
                host.Log("Could not save the window bounds.");
            }
        }

        public void UpdateBadge()
        {
            if (IsHandleCreated && Visible)
            {
                TaskbarBadge.Set(Handle, host.Badge);
            }
        }

        protected override void WndProc(ref Message message)
        {
            // Alt alone reveals the native menu. Alt+Space goes to the OS system menu.
            if (message.Msg == 0x0112 && (message.WParam.ToInt64() & 0xfff0) == 0xf100 && message.LParam == IntPtr.Zero && !fullScreen)
            {
                altMenu = true;
                desktopMenu.Show();
                desktopMenu.Focus();
                return;
            }
            base.WndProc(ref message);

            if (message.Msg == TaskbarBadge.ButtonCreated && host != null)
            {
                UpdateBadge();
            }
        }
    }

    static class TaskbarBadge
    {
        public static readonly int ButtonCreated = RegisterWindowMessage("TaskbarButtonCreated");

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int RegisterWindowMessage(string name);

        [DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr icon);

        [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
        class TaskbarList { }

        [ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface ITaskbarList3
        {
            // All methods before SetOverlayIcon, in vtable order, including those from ITaskbarList and ITaskbarList2.
            void HrInit();
            void AddTab(IntPtr window);
            void DeleteTab(IntPtr window);
            void ActivateTab(IntPtr window);
            void SetActiveAlt(IntPtr window);
            void MarkFullscreenWindow(IntPtr window, [MarshalAs(UnmanagedType.Bool)] bool fullScreen);
            void SetProgressValue(IntPtr window, ulong completed, ulong total);
            void SetProgressState(IntPtr window, int flags);
            void RegisterTab(IntPtr tab, IntPtr window);
            void UnregisterTab(IntPtr tab);
            void SetTabOrder(IntPtr tab, IntPtr before);
            void SetTabActive(IntPtr tab, IntPtr window, uint flags);
            void ThumbBarAddButtons(IntPtr window, uint count, IntPtr buttons);
            void ThumbBarUpdateButtons(IntPtr window, uint count, IntPtr buttons);
            void ThumbBarSetImageList(IntPtr window, IntPtr imageList);
            void SetOverlayIcon(IntPtr window, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string description);
        }

        public static void Set(IntPtr window, int count)
        {
            object shell = null;
            IntPtr icon = IntPtr.Zero;

            try
            {
                shell = new TaskbarList();
                ITaskbarList3 taskbar = shell as ITaskbarList3;

                if (taskbar == null)
                {
                    return;
                }

                taskbar.HrInit();

                if (count > 0)
                {
                    using (Bitmap image = new Bitmap(32, 32))
                    using (Graphics graphics = Graphics.FromImage(image))
                    using (Brush red = new SolidBrush(Color.FromArgb(180, 30, 48)))
                    using (Font font = new Font("Segoe UI", count > 99 ? 12 : 17, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (StringFormat center = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    {
                        graphics.SmoothingMode = SmoothingMode.AntiAlias;
                        graphics.FillEllipse(red, 0, 0, 32, 32);
                        graphics.DrawString(count > 99 ? "99+" : count.ToString(), font, Brushes.White,
                            new RectangleF(0, 0, 32, 32), center);
                        icon = image.GetHicon();
                    }
                }

                taskbar.SetOverlayIcon(window, icon, count > 0 ? count + " sessions need you" : "");
            }
            catch (COMException)
            {
                // Explorer may not have the taskbar button yet. TaskbarButtonCreated tries again.
            }
            finally
            {
                if (icon != IntPtr.Zero)
                {
                    DestroyIcon(icon);
                }

                if (shell != null)
                {
                    Marshal.ReleaseComObject(shell);
                }
            }
        }
    }
}
