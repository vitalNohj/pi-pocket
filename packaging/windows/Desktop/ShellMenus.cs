using System;
using System.Drawing;
using System.Windows.Forms;

namespace PiPocket
{
    sealed partial class TrayApp
    {
        readonly ContextMenuStrip trayMenu = new ContextMenuStrip();

        void MakeTrayMenu()
        {
            trayMenu.Opening += delegate (object sender, System.ComponentModel.CancelEventArgs args)
            {
                args.Cancel = false;
                while (trayMenu.Items.Count > 0)
                {
                    ToolStripItem old = trayMenu.Items[0];
                    trayMenu.Items.RemoveAt(0);
                    old.Dispose();
                }
                object menu = ShellWire.Get(ShellWire.Get(snapshot, "menus"), "tray");
                foreach (object entry in ShellWire.Items(menu)) { trayMenu.Items.Add(TrayEntry(entry)); }
                if (trayMenu.Items.Count == 0)
                {
                    trayMenu.Items.Add("Open Pi Pocket", null, delegate { OpenWindow(); });
                    trayMenu.Items.Add("Desktop Settings…", null, delegate { OpenSettings(null); });
                    trayMenu.Items.Add("Quit Pi Pocket", null, delegate { Quit(); });
                }
            };
            tray.ContextMenuStrip = trayMenu;
        }

        ToolStripItem TrayEntry(object entry)
        {
            if (ShellWire.Flag(entry, "separator")) { return new ToolStripSeparator(); }
            // Ampersands are WinForms mnemonic markers, not part of a session title.
            string label = (ShellWire.Text(entry, "label") ?? "").Replace("&", "&&");
            ToolStripMenuItem item = new ToolStripMenuItem(label);
            object children = ShellWire.Get(entry, "items");
            if (children != null)
            {
                foreach (object child in ShellWire.Items(children)) { item.DropDownItems.Add(TrayEntry(child)); }
            }
            else
            {
                string id = ShellWire.Text(entry, "id");
                object data = ShellWire.Get(entry, "data");
                item.Enabled = ShellWire.Flag(entry, "enabled");
                item.Click += delegate { ShellAction(id, data); };
            }
            return item;
        }

        public bool MenuEnabled(string action)
        {
            if (action == "window.devTools") { return NativeDeveloperTools; }
            if (action == "home.local.restart") { return localPage && ShellWire.Flag(ShellWire.Get(ShellWire.Get(snapshot, "home"), "local"), "verified"); }
            return true;
        }
    }

    sealed partial class PocketWindow
    {
        readonly MenuStrip desktopMenu = new MenuStrip { Dock = DockStyle.None, Visible = false };
        readonly Label remoteNotice = new Label { AutoSize = true, Padding = new Padding(8, 5, 8, 5) };
        readonly ToolStrip shellStrip = new ToolStrip { Dock = DockStyle.None, Visible = false, GripStyle = ToolStripGripStyle.Hidden };
        bool altMenu;

        void AddDesktopMenus()
        {
            ToolStripMenuItem file = Group("&File", Command("New Session", "window.newSession", Keys.Control | Keys.N),
                Command("New Window", "window.newWindow", Keys.Control | Keys.Shift | Keys.N), new ToolStripSeparator(),
                Command("Desktop Settings…", "settings.open", Keys.Control | Keys.Oemcomma),
                Command("Close", "window.close", Keys.Control | Keys.W), Command("Quit Pi Pocket", "app.quit", Keys.Control | Keys.Q));
            ToolStripMenuItem edit = Group("&Edit", Edit("Undo", "undo", Keys.Control | Keys.Z),
                Edit("Redo", "redo", Keys.Control | Keys.Shift | Keys.Z), new ToolStripSeparator(),
                Edit("Cut", "cut", Keys.Control | Keys.X), Edit("Copy", "copy", Keys.Control | Keys.C),
                Edit("Paste", "paste", Keys.Control | Keys.V), Edit("Select All", "selectAll", Keys.Control | Keys.A));
            ToolStripMenuItem viewMenu = Group("&View", Command("Back", "window.back", Keys.Alt | Keys.Left),
                Command("Forward", "window.forward", Keys.Alt | Keys.Right), Command("Reload", "window.reload", Keys.Control | Keys.R),
                Command("Developer Tools", "window.devTools", Keys.Control | Keys.Shift | Keys.I), new ToolStripSeparator(),
                Command("Actual Size", "window.actualSize", Keys.Control | Keys.D0), Command("Zoom In", "window.zoomIn", Keys.Control | Keys.Oemplus),
                Command("Zoom Out", "window.zoomOut", Keys.Control | Keys.OemMinus), Command("Full Screen", "window.fullScreen", Keys.F11));
            ToolStripMenuItem windows = Group("&Window", Command("Minimize", "window.minimize"),
                new ToolStripMenuItem("Maximize / Restore", null, delegate { WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized; }),
                Command("Restart Server", "home.local.restart"));
            ToolStripMenuItem help = Group("&Help", Command("Fork on GitHub", "help.repository"), Command("Documentation", "help.documentation"),
                Command("Desktop Releases", "help.releases"), Command("Open Diagnostics Log", "logs.open"));
            desktopMenu.Items.AddRange(new ToolStripItem[] { file, edit, viewMenu, windows, help });
            desktopMenu.MenuDeactivate += delegate { HideAltMenu(); };
            MainMenuStrip = desktopMenu;
            shellStrip.Items.Add(new ToolStripButton("Desktop Settings…", null, delegate { host.ShellAction("settings.open"); }));
            shellStrip.Items.Add(new ToolStripControlHost(remoteNotice));
            Controls.Add(shellStrip);
            Controls.Add(desktopMenu);
            Activated += delegate { host.Report("focus", true); };
            Deactivate += delegate { host.Report("focus", false); HideAltMenu(); };
            ApplyShellPreferences();
        }

        ToolStripMenuItem Group(string label, params ToolStripItem[] items)
        {
            return new ToolStripMenuItem(label, null, items);
        }

        ToolStripMenuItem Command(string label, string action, Keys shortcut = Keys.None)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(label) { ShortcutKeys = shortcut, Tag = action };
            item.Click += delegate { host.ShellAction(action); };
            return item;
        }

        ToolStripMenuItem Edit(string label, string command, Keys shortcut)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(label) { ShortcutKeyDisplayString = new KeysConverter().ConvertToString(shortcut) };
            // Real editing shortcuts are handled by WebView2, not by the menu.
            item.Click += async delegate
            {
                if (Browser == null) { return; }
                try { await Browser.ExecuteScriptAsync("document.execCommand(" + json.Serialize(command) + ")"); }
                catch (InvalidOperationException) { }
            };
            return item;
        }

        public void ApplyShellPreferences()
        {
            ApplyWindowPreferences();
            foreach (ToolStripMenuItem group in desktopMenu.Items)
            {
                foreach (ToolStripItem item in group.DropDownItems)
                {
                    string action = item.Tag as string;
                    if (action != null) { item.Enabled = host.MenuEnabled(action); }
                }
            }
        }

        public void ShowPageNotice(string message)
        {
            remoteNotice.Text = message ?? "";
            LayoutChrome();
        }

        void HideAltMenu()
        {
            altMenu = false;
            LayoutChrome();
        }

        protected override bool ProcessCmdKey(ref Message message, Keys key)
        {
            if (key == (Keys.Alt | Keys.Space))
            {
                // Keep the OS window menu even when WebView2 has keyboard focus.
                SendMessage(Handle, 0x0112, new IntPtr(0xF100), new IntPtr(' '));
                return true;
            }
            foreach (ToolStripMenuItem group in desktopMenu.Items)
            {
                foreach (ToolStripItem item in group.DropDownItems)
                {
                    ToolStripMenuItem command = item as ToolStripMenuItem;
                    if (command != null && command.Tag is string && command.ShortcutKeys == key && command.Enabled)
                    {
                        host.ShellAction((string)command.Tag);
                        return true;
                    }
                }
            }
            return base.ProcessCmdKey(ref message, key);
        }

        public void Zoom(double delta)
        {
            if (Browser != null) { view.ZoomFactor = delta == 0 ? 1 : Math.Max(0.5, Math.Min(3, view.ZoomFactor + delta)); }
        }
    }
}
