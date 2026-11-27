using System;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PiPocket
{
    sealed partial class TrayApp
    {
        WindowPreferences windowPrefs = WindowPreferences.Defaults;
        WindowHotkey windowHotkey;
        string windowEffect;
        bool readingLogin;
        internal WindowPreferences WindowPrefs { get { return windowPrefs; } }
        internal bool NativeCloseToTray { get { return windowPrefs.closeToTray; } }
        internal bool NativeShowMenuBar { get { return windowPrefs.showMenuBar; } }
        internal bool NativeDeveloperTools { get { return windowPrefs.developerTools; } }

        void StartWindowActions()
        {
            windowHotkey = new WindowHotkey(delegate {
                if (window != null && !window.IsDisposed && window.IsForeground) { window.Hide(); }
                else if (!ready && settings != null && Form.ActiveForm == settings) { settings.Hide(); }
                else if (ready) { OpenWindow(); }
                else { OpenSettings("runner"); }
            });
        }

        void ApplySavedWindowPreferences(object next, bool first)
        {
            windowPrefs = WindowPreferences.Read(ShellWire.Get(next, "preferences"));
            if (!first) { return; }
            if (loginLaunch && !windowPrefs.startHidden) { openWhenReady = true; }
            try { SetWindowHotkey(windowPrefs.shortcutEnabled, windowPrefs.shortcut); }
            catch (InvalidOperationException error) { Log(error.Message); }
            RefreshWindowPlatform();
        }

        void SetWindowHotkey(bool enabled, string shortcut)
        {
            if (!enabled) { windowHotkey.Clear(); }
            else if (!windowHotkey.Bind(shortcut))
            {
                Report("window.status", new { shortcutActive = windowHotkey.Active });
                throw new InvalidOperationException("The show/hide shortcut is already in use or reserved by Windows. Choose another shortcut.");
            }
            Report("window.status", new { shortcutActive = windowHotkey.Active });
        }

        internal void ReportWindowEffect(PocketWindow source, string effect)
        {
            if (source != window) { return; }
            if (effect == "page" && !PocketWindow.AllowsTransparency()) { effect = "unsupported"; }
            if (effect == windowEffect) { return; }
            windowEffect = effect;
            Report("window.status", new { effect = effect });
        }

        async void RefreshWindowPlatform()
        {
            if (window != null) { window.ApplyWindowPreferences(); }
            ReportWindowEffect(window, window == null ? "page" : window.EffectStatus ?? "page");
            if (readingLogin) { return; }
            readingLogin = true;
            try { Report("platform", new { loginEnabled = await Task.Run(() => WindowLogin.Enabled) }); }
            catch (Exception) { Log("Could not read the login shortcut."); }
            finally { readingLogin = false; }
        }

        async Task<object> SetWindowLogin(bool enabled)
        {
            try
            {
                return await Task.Run<object>(delegate
                {
                    WindowLogin.Set(enabled);
                    return WindowLogin.Enabled;
                });
            }
            catch (Exception) { throw new InvalidOperationException("Could not change Launch at login in Windows."); }
        }

        async Task PrepareWindowLogin()
        {
            try { await Task.Run(() => WindowLogin.UpdateLegacyShortcut()); }
            catch (Exception) { throw new InvalidOperationException("Could not update the Windows login shortcut."); }
        }

        internal void DownloadNotice(string message)
        {
            Log(message);
            LocalNotice(message);
        }
    }

    // The controller owns persisted preferences. This is a typed copy for Win32 and WebView2.
    internal sealed class WindowPreferences
    {
        public string titleBar, shortcut, material, trayStyle;
        public bool closeToTray, startHidden, showMenuBar, externalPages, shortcutEnabled, seeThrough, developerTools;
        public int opacity;

        public static WindowPreferences Defaults
        {
            get { return new WindowPreferences { titleBar = "system", closeToTray = true, shortcut = "Ctrl+Shift+P", opacity = 82, material = "acrylic", trayStyle = "system" }; }
        }

        public static WindowPreferences Read(object preferences)
        {
            object window = ShellWire.Get(preferences, "window");
            object appearance = ShellWire.Get(preferences, "appearance");
            if (window == null || appearance == null) { return Defaults; }
            return new WindowPreferences {
                titleBar = ShellWire.Text(window, "titleBar"),
                closeToTray = ShellWire.Flag(window, "closeToTray"),
                startHidden = ShellWire.Flag(window, "startHidden"),
                showMenuBar = ShellWire.Flag(window, "showMenuBar"),
                externalPages = ShellWire.Text(window, "links") == "browser",
                shortcutEnabled = ShellWire.Flag(window, "shortcutEnabled"),
                shortcut = ShellWire.Text(window, "shortcut"),
                developerTools = ShellWire.Flag(window, "developerTools"),
                seeThrough = ShellWire.Flag(appearance, "transparent"),
                opacity = ShellWire.Number(appearance, "opacity"),
                material = ShellWire.Text(appearance, "material"),
                trayStyle = ShellWire.Text(appearance, "trayStyle"),
            };
        }
    }
}
