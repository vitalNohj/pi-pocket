using System;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace PiPocket
{
    sealed partial class TrayApp
    {
        readonly WindowPreferences windowPrefs = PiPocket.WindowPreferences.Load();
        WindowHotkey windowHotkey;
        internal WindowPreferences WindowPrefs { get { return windowPrefs; } }
        internal bool NativeCloseToTray { get { return WindowPrefs.closeToTray ?? CloseToTray; } }
        internal bool NativeShowMenuBar { get { return WindowPrefs.showMenuBar ?? ShowMenuBar; } }
        internal bool NativeDeveloperTools { get { return WindowPrefs.developerTools ?? DeveloperTools; } }

        void StartWindowActions()
        {
            windowHotkey = new WindowHotkey(delegate {
                if (window != null && !window.IsDisposed && window.IsForeground) { window.Hide(); }
                else { OpenWindow(); }
            });
            if (WindowPrefs.globalShortcut && !windowHotkey.Bind(WindowHotkey.DefaultModifiers, WindowHotkey.DefaultKey))
            {
                DownloadNotice("The show/hide shortcut is already in use.");
            }
        }

        internal void SaveWindowPreferences()
        {
            try { WindowPrefs.Save(); }
            catch (Exception) { DownloadNotice("Could not save the window options."); }
            if (window != null) { window.ApplyShellPreferences(); }
            foreach (PocketWindow extra in popups.ToArray()) { extra.ApplyShellPreferences(); }
        }

        internal void ToggleWindowHotkey()
        {
            if (WindowPrefs.globalShortcut) { windowHotkey.Clear(); }
            else if (!windowHotkey.Bind(WindowHotkey.DefaultModifiers, WindowHotkey.DefaultKey))
            {
                DownloadNotice("The show/hide shortcut is already in use.");
                return;
            }
            WindowPrefs.globalShortcut = !WindowPrefs.globalShortcut;
            SaveWindowPreferences();
        }

        internal void ToggleWindowLogin()
        {
            try { WindowLogin.Set(!WindowLogin.Enabled); }
            catch (Exception) { DownloadNotice("Could not change launch at login."); }
        }

        internal void ToggleStartHidden()
        {
            WindowPrefs.startHidden = !WindowPrefs.startHidden;
            if (WindowLogin.Enabled)
            {
                try { WindowLogin.Set(true); }
                catch (Exception) { DownloadNotice("Could not update the login shortcut."); }
            }
            SaveWindowPreferences();
        }

        internal void DownloadNotice(string message)
        {
            Log(message);
            LocalNotice(message);
        }
    }

    // The native window settings adapter. Keep independent of server config and browser storage.
    internal sealed class WindowPreferences
    {
        public string titleBar { get; set; }
        public bool? closeToTray { get; set; }
        public bool startHidden { get; set; }
        public bool? showMenuBar { get; set; }
        public bool externalPages { get; set; }
        public bool globalShortcut { get; set; }
        public bool seeThrough { get; set; }
        public int opacity { get; set; }
        public string material { get; set; }
        public bool? developerTools { get; set; }

        public WindowPreferences()
        {
            titleBar = "seamless";
            opacity = 82;
            material = "acrylic";
        }

        static string FileName
        {
            get
            {
                string folder = Environment.GetEnvironmentVariable("PI_POCKET_DESKTOP_STATE");
                return Path.Combine(string.IsNullOrEmpty(folder)
                    ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pi Pocket", "desktop")
                    : folder, "window.json");
            }
        }

        public static WindowPreferences Load()
        {
            WindowPreferences value = null;

            try
            {
                var file = new FileInfo(FileName);
                if (file.Exists && file.Length <= 4096)
                {
                    value = new JavaScriptSerializer().Deserialize<WindowPreferences>(File.ReadAllText(file.FullName));
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }

            if (value == null)
            {
                value = new WindowPreferences();
                if (File.Exists(Path.Combine(Application.StartupPath, "window-bounds.txt")))
                {
                    value.titleBar = "system";
                }
            }

            if (value.titleBar != "system") { value.titleBar = "seamless"; }
            if (value.material != "mica") { value.material = "acrylic"; }
            if (value.opacity < 0 || value.opacity > 100) { value.opacity = 82; }

            return value;
        }

        public void Save()
        {
            string file = FileName;
            string temp = file + "." + Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(Path.GetDirectoryName(file));

            try
            {
                File.WriteAllText(temp, new JavaScriptSerializer().Serialize(this));
                if (File.Exists(file)) { File.Replace(temp, file, null); }
                else { File.Move(temp, file); }
            }
            finally
            {
                if (File.Exists(temp)) { File.Delete(temp); }
            }
        }
    }
}
