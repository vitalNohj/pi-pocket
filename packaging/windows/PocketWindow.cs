// The Windows web view and version 1 app bridge (docs/embedders.md). The tray owns the window, not the other way round.
using System;
using System.Diagnostics;
using System.Drawing;
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
        readonly string origin, basePath;
        readonly string boundsFile;
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 8 };
        readonly WebView2 view = new WebView2();
        bool committed;
        string committedOrigin;
        readonly int generation;
        readonly bool bridgeEnabled;
        readonly string[] allowed;
        BridgeView bridge;

        // One reload and one fresh view per incident. Finishing a navigation is not proof of recovery.
        const long StartLimit = 15000, HangLimit = 10000, StableTime = 5000;
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly Timer recoveryTimer = new Timer { Interval = 1000 };
        readonly ToolStripButton retryPage;
        readonly string entryAddress;
        long attemptAt, answeredAt, lastTick, readyAt = -1;
        int attempt, epoch;
        bool watching, initialized, documentReady, sawReady, checkPending, processExited, browserExited, blocked;
        bool showWithoutActivation;
        string recoveryAddress;
        internal readonly ShellWebProfile Profile;
        internal string RecoveryState { get; private set; }
        internal string CommittedOrigin { get { return committedOrigin; } }
        internal bool IsMain { get { return boundsFile != null; } }
        internal bool IsCurrent { get { return !IsDisposed && !Disposing && generation == host.PageGeneration; } }
        internal int RecoveryEpoch { get { return epoch; } }

        public PocketWindow(TrayApp host, string address, Icon icon, string boundsFile, ShellWebProfile profile, int attempt = 0)
        {
            this.host = host;
            entryAddress = recoveryAddress = address;
            Profile = profile;
            this.attempt = attempt;
            RecoveryState = attempt == 0 ? "loading" : "recovering";
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
            retryPage = new ToolStripButton("Reload", null, delegate { ReloadPage(); }) { Available = false };
            shellStrip.Items.Insert(1, retryPage);
            recoveryTimer.Tick += delegate { WatchPage(); };
            VisibleChanged += delegate { LayoutChrome(); PublishVisibility(); };
            Resize += delegate { LayoutChrome(); PublishVisibility(); };
            DpiChanged += delegate { LayoutChrome(); };
        }

        public CoreWebView2 Browser { get { return view.CoreWebView2; } }
        internal bool ShownToUser { get { return Visible && WindowState != FormWindowState.Minimized; } }

        public async Task Initialize()
        {
            watching = true;
            BeginAttempt();
            recoveryTimer.Start();
            await host.InitializeWebView(view, Profile);
            if (!IsCurrent) { return; }
            CoreWebView2 core = Browser;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = host.NativeDeveloperTools;
            core.NavigationStarting += Navigate;
            core.ContentLoading += delegate (object sender, CoreWebView2ContentLoadingEventArgs args)
            {
                if (!IsCurrent || args.NavigationId != navigation) { return; }
                committed = !args.IsErrorPage && IsServerAddress(core.Source, origin);
                committedOrigin = args.IsErrorPage || !IsAppAddress(core.Source) ? null : new Uri(core.Source).GetLeftPart(UriPartial.Authority);
                host.ReportPage(this);
            };
            core.NavigationCompleted += delegate (object sender, CoreWebView2NavigationCompletedEventArgs args)
            {
                if (!IsCurrent || args.NavigationId != navigation) { return; }
                if (args.IsSuccess && args.HttpStatusCode < 500 ||
                    args.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled && IsAppAddress(core.Source))
                {
                    documentReady = true;
                    answeredAt = clock.ElapsedMilliseconds;
                }
                else if (!blocked)
                {
                    DetachDictation();
                    PresentRecovery(RecoveryState, "Could not load this server. Check the address or try again.");
                }
            };
            core.ProcessFailed += delegate (object sender, CoreWebView2ProcessFailedEventArgs args)
            {
                if (!IsCurrent || (args.ProcessFailedKind != CoreWebView2ProcessFailedKind.RenderProcessExited &&
                    args.ProcessFailedKind != CoreWebView2ProcessFailedKind.BrowserProcessExited)) { return; }
                DetachDictation();
                committed = false;
                committedOrigin = null;
                epoch++;
                readyAt = -1;
                documentReady = false;
                if (!processExited) { host.WriteWebViewLog("Page recovery (" + Role + "): renderer exited."); }
                processExited = true;
                browserExited |= args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited;
                // Recover outside the callback. The old controller must be disposed before creating a new one.
                if (RecoveryState != "failed") { PresentRecovery("hung", "The page is not responding. Reload it or open Desktop Settings."); }
            };
            core.NewWindowRequested += host.NewWindowRequested;
            core.WindowCloseRequested += delegate { if (IsCurrent) { BeginInvoke((MethodInvoker)Close); } };

            if (IsMain && bridgeEnabled) { core.WebResourceResponseReceived += CheckSignIn; }
            await InitializeChrome(core.Environment);
            if (!IsCurrent) { return; }
            if (bridgeEnabled)
            {
                bridge = new BridgeView(host.Bridge, this, core, origin, basePath, host.InvokeBridgeAction, ReceiveDictation);
                await bridge.Attach(InstallDictation());
            }
            if (IsCurrent) { initialized = true; }
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
            if (!IsCurrent) { args.Cancel = true; return; }
            if (downloads != null) { downloads.Navigating(args); }
            Uri target, current;
            bool downgrade = Uri.TryCreate(Browser.Source, UriKind.Absolute, out current) && current.Scheme == "https" &&
                Uri.TryCreate(args.Uri, UriKind.Absolute, out target) && target.Scheme == "http";
            if (!IsAppAddress(args.Uri) || downgrade)
            {
                args.Cancel = true;
                if (args.IsUserInitiated && !args.IsRedirected) { host.OpenInDefaultBrowser(args.Uri); }
                else
                {
                    blocked = true;
                    PresentRecovery("failed", "This sign-in address is not allowed. Review allowed origins under Server.");
                }
                return;
            }

            if (navigation != args.NavigationId)
            {
                BeginAttempt();
                PrepareRecoveryAddress(args.Uri);
            }
            if (args.IsRedirected || navigation != args.NavigationId) { DetachDictation(); }
            navigation = args.NavigationId;
            ResetWindowPage();
            committed = false;
            committedOrigin = null;
            if (bridge != null) { bridge.Navigating(navigation); }
        }

        void BeginAttempt()
        {
            epoch++;
            attemptAt = answeredAt = clock.ElapsedMilliseconds;
            readyAt = -1;
            documentReady = sawReady = checkPending = processExited = blocked = false;
            PresentRecovery(attempt == 0 ? "loading" : "recovering", attempt == 0 ? null : "Trying to recover the page…");
        }

        // Remember only a normal Pi Pocket route. Never reuse a one-time sign-in URL or SSO redirect.
        bool SafeAddress(string address)
        {
            if (!IsServerAddress(address, origin)) { return false; }
            Uri candidate = new Uri(address);
            return (candidate.Query.Length == 0 || candidate.Query == "?pip=1") && candidate.Fragment.Length == 0 &&
                BridgeProtocol.IsPage(candidate.AbsolutePath, basePath);
        }

        internal void PrepareRecoveryAddress(string address)
        {
            recoveryAddress = SafeAddress(address) ? address : entryAddress;
        }

        void PresentRecovery(string state, string notice)
        {
            bool changed = RecoveryState != state;
            RecoveryState = state;
            retryPage.Available = state == "hung" || state == "failed";
            if (remoteNotice.Text != (notice ?? "")) { ShowPageNotice(notice); }
            if (changed) { host.ReportPage(this); }
        }

        internal void ConnectionLost()
        {
            if (RecoveryState == "ready" || RecoveryState == "loading")
            {
                ShowPageNotice("Connection lost. Pi Pocket will retry. Open Desktop Settings to retry now.");
            }
        }

        internal void ConnectionRestored()
        {
            if (!IsCurrent || blocked) { return; }
            if (RecoveryState == "ready") { ShowReadyNotice(); }
            else { ReloadPage(); }
        }

        internal void InitializationFailed()
        {
            if (!IsCurrent) { return; }
            processExited = true;
            PresentRecovery("recovering", "Could not open the embedded page. Trying again…");
        }

        internal void NavigateInitial(string address, int token)
        {
            if (IsCurrent && initialized && token == epoch && !browserExited)
            {
                Browser.Navigate(address);
            }
        }

        string Role { get { return IsMain ? "main" : "extra"; } }

        void WatchPage()
        {
            if (!watching || !IsCurrent) { return; }
            long now = clock.ElapsedMilliseconds;
            bool interrupted = now - lastTick > HangLimit;
            lastTick = now;
            if (blocked) { return; }
            if (!processExited && (!ShownToUser || interrupted))
            {
                attemptAt = answeredAt = now;
                readyAt = -1;
                return;
            }

            long silent = now - answeredAt;
            if (documentReady && silent >= HangLimit)
            {
                readyAt = -1;
                if (RecoveryState != "failed") { PresentRecovery("hung", "The page is not responding. Reload it or open Desktop Settings."); }
            }
            bool expired = !sawReady && now - attemptAt >= StartLimit || documentReady && silent >= StartLimit;
            if (!host.PageReconnecting && (processExited || expired) && RecoveryState != "failed")
            {
                if (attempt == 0)
                {
                    attempt++;
                    host.WriteWebViewLog("Page recovery (" + Role + "): reloading.");
                    RetryNavigation();
                }
                else if (attempt == 1)
                {
                    host.WriteWebViewLog("Page recovery (" + Role + "): recreating.");
                    host.RecreatePage(this, entryAddress, recoveryAddress, boundsFile, 2);
                }
                else
                {
                    host.WriteWebViewLog("Page recovery (" + Role + "): stopped.");
                    PresentRecovery("failed", "The page could not recover. Reload it or open Desktop Settings to check the connection.");
                }
                return;
            }

            if (documentReady && !checkPending && !browserExited) { CheckPage(epoch); }
        }

        async void CheckPage(int token)
        {
            checkPending = true;
            string answer;
            try
            {
                // One read-only check in the current top document, even if it never replies.
                string script = bridgeEnabled && committed
                    ? "[...document.querySelectorAll('[data-part=boot]')].some(e => !e.classList.contains('inline')) ? 'boot' : 'ready'"
                    : "'ready'";
#if DESKTOP_RECOVERY_SMOKE
                if (RecoveryFixture) { script = "document.body?.hasAttribute('data-fixture-exit') ? 'exit' : (" + script + ")"; }
#endif
                answer = await Browser.ExecuteScriptAsync(script);
            }
            catch (InvalidOperationException) { answer = null; }
            catch (COMException) { answer = null; }
            if (!IsCurrent || token != epoch) { return; }
            checkPending = false;
#if DESKTOP_RECOVERY_SMOKE
            if (answer == "\"exit\"")
            {
                try { await Browser.CallDevToolsProtocolMethodAsync("Page.crash", "{}"); }
                catch (Exception) { /* The renderer exited. Recovery uses ProcessFailed, not this result. */ }
                return;
            }
#endif
            if (answer != "\"ready\"" && answer != "\"boot\"") { return; }
            answeredAt = clock.ElapsedMilliseconds;
            if (answer == "\"boot\"")
            {
                if (sawReady) { attemptAt = answeredAt; }
                sawReady = false;
                readyAt = -1;
                return;
            }
            sawReady = true;
            if (SafeAddress(Browser.Source)) { PrepareRecoveryAddress(Browser.Source); }
            if (readyAt < 0) { readyAt = answeredAt; }
            if (answeredAt - readyAt >= StableTime) { attempt = 0; }
            ShowReadyNotice();
        }

#if DESKTOP_RECOVERY_SMOKE
        bool RecoveryFixture { get { return Profile == ShellWebProfile.Remote && new Uri(origin).IsLoopback &&
            Environment.GetEnvironmentVariable("PI_POCKET_RECOVERY_SMOKE") == "1" &&
            !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PI_POCKET_DESKTOP_STATE")); } }
#endif

        void ShowReadyNotice()
        {
            PresentRecovery("ready", host.PageReconnecting
                ? "Connection lost. Pi Pocket will retry. Open Desktop Settings to retry now."
                : !bridgeEnabled || !committed ? "Sign in on this page to use Pi Pocket" : null);
        }

        void RetryNavigation()
        {
            BeginAttempt();
            if (!initialized || browserExited) { return; }
            try
            {
                // Reload in place to keep the native history when the renderer can still use it.
                if (SafeAddress(Browser.Source) && Browser.Source == recoveryAddress) { Browser.Reload(); }
                else { Browser.Navigate(recoveryAddress); }
            }
            catch (InvalidOperationException) { browserExited = true; }
            catch (COMException) { browserExited = true; }
        }

        internal void ReloadPage()
        {
            if (!IsCurrent) { return; }
            attempt = 0;
            if (!initialized || browserExited) { host.RecreatePage(this, entryAddress, recoveryAddress, boundsFile, 0); }
            else { RetryNavigation(); }
        }

        internal void CopyWindowState(PocketWindow previous)
        {
            StartPosition = FormStartPosition.Manual;
            Bounds = previous.WindowState == FormWindowState.Normal ? previous.Bounds : previous.RestoreBounds;
            WindowState = previous.WindowState;
        }

        protected override bool ShowWithoutActivation { get { return showWithoutActivation; } }

        internal void ShowInBackground()
        {
            showWithoutActivation = true;
            try { Show(); }
            finally { showWithoutActivation = false; }
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

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                watching = false;
                recoveryTimer.Dispose();
                if (downloads != null) { downloads.Dispose(); downloads = null; }
                if (viewClip != null) { viewClip.Dispose(); viewClip = null; }
            }
            base.Dispose(disposing);
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
            if (message.Msg == DictationFixtureMenuMessage && ShowDictationFixtureMenu()) { return; }
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
