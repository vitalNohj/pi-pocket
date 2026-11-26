using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PiPocket
{
    sealed partial class TrayApp
    {
        readonly string shellFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pi Pocket");
        ShellController controller;
        ShellSettings settings;
        object snapshot;
        string stateFolder;
        string pageAddress;
        int pageGeneration;
        string pageStatus;
        bool localPage;
        bool pageBridge;
        bool restartingServer;
        bool pendingSession;
        string[] otherOrigins = new string[0];

        internal bool ShowMenuBar { get { return ShellWire.Flag(WindowPreferences, "showMenuBar"); } }
        internal bool DeveloperTools { get { return ShellWire.Flag(WindowPreferences, "developerTools"); } }
        internal bool CloseToTray { get { return snapshot == null || ShellWire.Flag(WindowPreferences, "closeToTray"); } }
        internal int PageGeneration { get { return pageGeneration; } }
        internal bool PageBridge { get { return pageBridge; } }
        internal string[] OtherOrigins { get { return otherOrigins; } }
        object WindowPreferences { get { return ShellWire.Get(ShellWire.Get(snapshot, "preferences"), "window"); } }
        bool NotificationsEnabled { get { return snapshot == null || ShellWire.Flag(ShellWire.Get(ShellWire.Get(snapshot, "preferences"), "notifications"), "enabled"); } }

        async void StartShell()
        {
            string custom = Environment.GetEnvironmentVariable("PI_POCKET_DESKTOP_STATE");
            stateFolder = string.IsNullOrEmpty(custom) ? Path.Combine(shellFolder, "desktop") : Path.GetFullPath(custom);
            bool existing = string.IsNullOrEmpty(custom) && (File.Exists(logFile) ||
                File.Exists(Path.Combine(appDir, "window-bounds.txt")) || File.Exists(Path.Combine(appDir, "desktop-upgrade.txt")));
            bool fresh = !existing && !File.Exists(Path.Combine(stateFolder, "desktop.json"));
            ProcessStartInfo start = new ProcessStartInfo(Path.Combine(appDir, @"node\node.exe"),
                Quote(Path.Combine(appDir, @"desktop-assets\controller\main.mjs")) + " " + Quote(stateFolder) +
                " windows " + Quote(Program.Version) + (existing ? " existing" : " new"));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.StandardOutputEncoding = System.Text.Encoding.UTF8;
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            start.EnvironmentVariables.Remove("NODE_PATH");
            controller = new ShellController(start, packet => OnUi(delegate { ControllerPacket(packet); }),
                () => OnUi(delegate
                {
                    if (!quitting) { ShowBalloon("Pi Pocket", "Desktop Settings could not connect to the controller. Try reinstalling Pi Pocket.", ToolTipIcon.Warning, null); }
                }));
            Task<object> subscribed = controller.Call("subscribe");
            if (openWhenReady && fresh) { OpenSettings("home"); }
            try { ApplySnapshot(await subscribed); }
            catch (InvalidOperationException) { }
            if (openWhenReady && !fresh && pageGeneration == 0 && !quitting && ShellWire.Text(ShellWire.Get(ShellWire.Get(snapshot, "preferences"), "home"), "mode") != "local")
            {
                OpenSettings("home");
            }
        }

        async void ControllerPacket(object packet)
        {
            if (quitting) { return; }
            if (ShellWire.Text(packet, "type") == "state") { ApplySnapshot(ShellWire.Get(packet, "state")); return; }
            if (ShellWire.Text(packet, "type") != "host") { return; }
            int id = ShellWire.Number(packet, "id");
            string action = ShellWire.Text(packet, "action");
            object data = ShellWire.Get(packet, "data");
            object reply;

            try { reply = new { id = id, ok = true, value = await HandleOperation(action, data) }; }
            catch (InvalidOperationException error) { reply = new { id = id, ok = false, error = new { code = "native", message = error.Message } }; }
            catch (Exception) { reply = new { id = id, ok = false, error = new { code = "native", message = "Pi Pocket could not complete this action." } }; }
            try { await controller.Call("host.result", reply); }
            catch (InvalidOperationException) { }
        }

        void ApplySnapshot(object next)
        {
            if (next == null || quitting || ShellWire.Number(snapshot, "revision") > ShellWire.Number(next, "revision")) { return; }
            snapshot = next;
            if (settings != null) { settings.UpdateState(next); }
            if (window != null) { window.ApplyShellPreferences(); }
            foreach (PocketWindow extra in popups.ToArray()) { extra.ApplyShellPreferences(); }
            var home = ShellWire.Get(next, "home");
            var active = ShellWire.Get(home, "active");
            int generation = ShellWire.Number(active, "generation");
            string status = ShellWire.Text(active, "status");

            if (generation != pageGeneration)
            {
                try { CloseWindows(); }
                catch (InvalidOperationException) { }
                pageGeneration = generation;
                SetBadge(0);
                balloons.Clear();
                balloonAddress = null;
                edgeFallback = false;
                webEnvironment = null;
                pageAddress = ShellWire.Text(active, "address");
                ready = pageAddress != null;
                url = ready ? new Uri(pageAddress).GetLeftPart(UriPartial.Authority) : null;
                localPage = ShellWire.Text(active, "mode") == "local";
                pageBridge = ShellWire.Text(active, "kind") == "pocket";
                List<string> origins = new List<string>();
                foreach (object origin in ShellWire.Items(ShellWire.Get(active, "allowedOrigins")))
                {
                    if (origin is string) { origins.Add((string)origin); }
                }
                otherOrigins = origins.ToArray();
                if (ready && (openWhenReady || settings != null && settings.Visible)) { BackToPage(); }
                else if (!ready && openWhenReady) { OpenSettings("home"); }
            }
            else if (pageStatus == "reconnecting" && status == "connected" && window != null && window.Browser != null)
            {
                window.Browser.Reload();
            }
            if (status == "reconnecting" && pageStatus != status && settings == null && window != null && window.Visible)
            {
                window.ShowPageNotice("Connection lost. Pi Pocket will retry. Open Desktop Settings to retry now.");
            }
            pageStatus = status;
            if (generation == 0 && openWhenReady && ShellWire.Text(ShellWire.Get(home, "local"), "status") == "error") { OpenSettings("home"); }
            UpdateTrayText();
        }

        internal async void ShellAction(string action, object data = null)
        {
            if (quitting) { return; }
            if (action == "app.quit") { Quit(); return; }
            if (action == "window.open") { OpenWindow(); return; }
            if (controller == null) { return; }
            var value = new Dictionary<string, object> { { "id", action } };
            if (data != null) { value.Add("data", data); }
            try { await controller.Call("action", value); }
            catch (InvalidOperationException error) { ShowBalloon("Pi Pocket", error.Message, ToolTipIcon.Info, null); }
        }

        internal async void Report(string name, object data)
        {
            if (controller == null || quitting) { return; }
            try { await controller.Call("host.report", new { @event = name, data = data }); }
            catch (InvalidOperationException) { }
        }

        internal void ReportPage(PocketWindow page, string origin, bool? hung = null)
        {
            if (page != window) { return; }
            var data = new Dictionary<string, object> { { "generation", pageGeneration }, { "committedOrigin", origin } };
            if (hung.HasValue) { data.Add("hung", hung.Value); }
            else { SetBadge(0); }
            Report("page", data);
        }

        async Task<object> HandleOperation(string action, object data)
        {
            PocketWindow front = Form.ActiveForm as PocketWindow ?? window;
            switch (action)
            {
                case "settings.open": OpenSettings(ShellWire.Text(data, "section")); break;
                case "settings.back": BackToPage(); break;
                case "window.open": OpenWindow(); break;
                case "window.reload": if (front != null && front.Browser != null) { front.Browser.Reload(); } break;
                case "window.newSession":
                    if (front == null) { pendingSession = true; OpenWindow(); }
                    else { front.ShowWindow(); front.NewSession(); }
                    break;
                case "window.newWindow": await NewSessionWindow(); break;
                case "window.back": if (front != null && front.Browser != null && front.Browser.CanGoBack) { front.Browser.GoBack(); } break;
                case "window.forward": if (front != null && front.Browser != null && front.Browser.CanGoForward) { front.Browser.GoForward(); } break;
                case "window.pinned": if (front != null) { front.ShowWindow(); front.OpenAddress("/s/" + ShellWire.Text(data, "id")); } break;
                case "window.zoomIn": if (front != null) { front.Zoom(0.1); } break;
                case "window.zoomOut": if (front != null) { front.Zoom(-0.1); } break;
                case "window.actualSize": if (front != null) { front.Zoom(0); } break;
                case "window.devTools": if (DeveloperTools && front != null && front.Browser != null) { front.Browser.OpenDevToolsWindow(); } break;
                case "window.fullScreen": if (front != null) { front.ToggleFullScreen(); } break;
                case "window.minimize": if (front != null) { front.WindowState = FormWindowState.Minimized; } break;
                case "window.close": if (Form.ActiveForm != null) { Form.ActiveForm.Close(); } break;
                case "window.preferences": break;
                case "app.quit": Quit(); break;
                case "help.repository": OpenInDefaultBrowser("https://github.com/vitalNohj/pi-pocket"); break;
                case "help.documentation": OpenInDefaultBrowser("https://github.com/vitalNohj/pi-pocket/blob/desktop-native/docs/desktop-app.md"); break;
                case "help.releases": OpenInDefaultBrowser("https://github.com/vitalNohj/pi-pocket/releases"); break;
                case "preferences.open": await OpenText(Path.Combine(stateFolder, "desktop.json")); break;
                case "logs.open": await OpenText(Path.Combine(stateFolder, "diagnostics.log")); break;
                case "local.log": await OpenText(logFile); break;
                case "local.inspect": return await Task.Run(() => InspectLocal());
                case "local.open": return await Task.Run(() => OpenLocal());
                case "local.stop": return await Task.Run(() => StopLocal());
                case "local.restart": await RestartLocal(); break;
                default: throw new InvalidOperationException("This action is not available yet.");
            }
            return null;
        }

        static Task OpenText(string file)
        {
            return Task.Run(delegate
            {
                if (!File.Exists(file)) { throw new InvalidOperationException("There is no file to show yet."); }
                Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "notepad.exe"), Quote(file)) { UseShellExecute = false });
            });
        }

        internal async void OpenSettings(string section, bool activate = true)
        {
            if (quitting || controller == null) { return; }
            if (settings != null)
            {
                settings.SelectSection(section);
                if (activate) { settings.Show(); settings.Activate(); }
                return;
            }
            ShellSettings made = new ShellSettings(tray.Icon, (command, data) => controller.Call(command, data));
            settings = made;
            made.Disposed += delegate { if (settings == made) { settings = null; } };
            made.SelectSection(section);
            if (activate) { made.Show(); made.Activate(); }
            try
            {
                await made.Initialize(Path.Combine(stateFolder, "Settings WebView2"), Path.Combine(appDir, @"desktop-assets\settings"));
            }
            catch (Exception error)
            {
                made.Dispose();
                Console.Error.WriteLine("Desktop Settings WebView2 initialization failed: 0x{0:X8}", error.HResult);
                if (!quitting) { ShowBalloon("Pi Pocket", "Desktop Settings could not open. Install the WebView2 Runtime or run Setup again.", ToolTipIcon.Warning, null); }
            }
        }

        void BackToPage()
        {
            if (settings != null) { settings.Close(); }
            if (ready) { OpenWindow(); }
        }

        internal void MainClosed()
        {
            OnUi(delegate
            {
                if (popups.Count == 0) { Quit(); }
            });
        }
    }
}
