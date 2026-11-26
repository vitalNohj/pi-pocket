// The Windows web view and version 1 app bridge (docs/embedders.md). The tray owns the window, not the other way round.
using System;
using System.Drawing;
using System.Globalization;
using System.IO;
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
        readonly string origin, basePath;
        readonly string boundsFile;
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 8 };
        readonly WebView2 view = new WebView2();
        bool committed;
        bool recovered;
        readonly int generation;
        readonly bool bridgeEnabled;
        readonly string[] allowed;
        BridgeView bridge;

        public PocketWindow(TrayApp host, string address, Icon icon, string boundsFile)
        {
            this.host = host;
            Uri server = new Uri(address);
            origin = server.GetLeftPart(UriPartial.Authority);
            basePath = server.AbsolutePath.TrimEnd('/');
            this.boundsFile = boundsFile;
            generation = host.PageGeneration;
            bridgeEnabled = host.PageBridge;
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
            VisibleChanged += delegate { LayoutChrome(); PublishVisibility(); };
            Resize += delegate { LayoutChrome(); PublishVisibility(); };
            DpiChanged += delegate { LayoutChrome(); };
        }

        public CoreWebView2 Browser { get { return view.CoreWebView2; } }
        internal bool ShownToUser { get { return Visible && WindowState != FormWindowState.Minimized; } }

        public async Task Initialize(ShellWebProfile profile)
        {
            await host.InitializeWebView(view, profile);
            if (IsDisposed || generation != host.PageGeneration) { return; }
            CoreWebView2 core = Browser;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = host.DeveloperTools;
            core.NavigationStarting += Navigate;
            core.ContentLoading += delegate (object sender, CoreWebView2ContentLoadingEventArgs args)
            {
                if (args.NavigationId != navigation) { return; }
                committed = !args.IsErrorPage && IsServerAddress(core.Source, origin);
                host.ReportPage(this, committed ? origin : null);
                ShowPageNotice(!bridgeEnabled || !committed ? "Sign in on this page to use Pi Pocket" : null);
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

            if (boundsFile != null && bridgeEnabled)
            {
                core.WebResourceResponseReceived += CheckSignIn;
            }

            await InitializeChrome(core.Environment);
            if (bridgeEnabled)
            {
                bridge = new BridgeView(host.Bridge, this, core, origin, basePath, host.InvokeBridgeAction);
                await bridge.Attach();
            }
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
            downloads.Navigating(args);
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
            ResetWindowPage();
            committed = false;
            if (bridge != null) { bridge.Navigating(navigation); }
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

        void PublishVisibility()
        {
            if (boundsFile != null) { host.Report("visibility", ShownToUser); }
            if (bridge != null) { bridge.Visibility(); }
        }

        public void OpenAddress(string address)
        {
            if (bridge != null && BridgeProtocol.IsTarget(address)) { bridge.Deliver("open", address, null, false); }
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
                if (host.NativeCloseToTray) { args.Cancel = true; Hide(); }
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
                LayoutChrome();
                desktopMenu.Focus();
                return;
            }
            if (HandleChrome(ref message)) { return; }
            base.WndProc(ref message);

            if (message.Msg == TaskbarBadge.ButtonCreated && host != null)
            {
                UpdateBadge();
            }
        }
    }
}
