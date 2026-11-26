using System;
using System.Windows.Forms;

namespace PiPocket
{
    sealed partial class PocketWindow
    {
        void ShowWindowOptions()
        {
            if (IsDisposed) { return; }
            var menu = new ContextMenuStrip();
            FillWindowOptions(menu.Items);
            menu.Closed += delegate { menu.Dispose(); };
            menu.Show(Cursor.Position);
        }

        void FillWindowOptions(ToolStripItemCollection items)
        {
            WindowPreferences settings = host.WindowPrefs;
            items.Add(Option("Seamless title bar", settings.titleBar == "seamless", delegate { settings.titleBar = "seamless"; host.SaveWindowPreferences(); }));
            items.Add(Option("System title bar", settings.titleBar == "system", delegate { settings.titleBar = "system"; host.SaveWindowPreferences(); }));
            items.Add(new ToolStripSeparator());
            items.Add(Option("See-through background", settings.seeThrough, delegate { settings.seeThrough = !settings.seeThrough; host.SaveWindowPreferences(); }));
            items.Add(Option("Use Acrylic", settings.material == "acrylic", delegate { settings.material = "acrylic"; host.SaveWindowPreferences(); }));
            items.Add(Option("Use Mica", settings.material == "mica", delegate { settings.material = "mica"; host.SaveWindowPreferences(); }));
            items.Add(new ToolStripSeparator());
            items.Add(Option("Close to tray", host.NativeCloseToTray, delegate { settings.closeToTray = !host.NativeCloseToTray; host.SaveWindowPreferences(); }));
            items.Add(Option("Show menu bar", host.NativeShowMenuBar, delegate { settings.showMenuBar = !host.NativeShowMenuBar; host.SaveWindowPreferences(); }));
            items.Add(Option("Open other Pi Pocket pages in browser", settings.externalPages, delegate { settings.externalPages = !settings.externalPages; host.SaveWindowPreferences(); }));
            items.Add(Option("Show/hide shortcut (Ctrl+Shift+P)", settings.globalShortcut, host.ToggleWindowHotkey));
            items.Add(Option("Launch at login", WindowLogin.Enabled, host.ToggleWindowLogin));
            items.Add(Option("Start hidden at login", settings.startHidden, host.ToggleStartHidden));
            items.Add(Option("Enable developer tools", host.NativeDeveloperTools, delegate { settings.developerTools = !host.NativeDeveloperTools; host.SaveWindowPreferences(); }));
        }

        static ToolStripMenuItem Option(string label, bool selected, Action action)
        {
            return new ToolStripMenuItem(label, null, delegate { action(); }) { Checked = selected };
        }
    }
}
