using System.Drawing;
using System.Windows.Forms;

namespace PiPocket
{
    sealed partial class PocketWindow
    {
        void ShowWindowOptions()
        {
            if (IsDisposed) { return; }
            var menu = new ContextMenuStrip();
            menu.Items.Add("Window Settings…", null, delegate { host.OpenSettings("window"); });
            menu.Items.Add("Appearance Settings…", null, delegate { host.OpenSettings("appearance"); });
            menu.Closed += delegate { menu.Dispose(); };
            menu.Show(Cursor.Position);
        }
    }

    sealed partial class TrayApp
    {
        internal void ReportWindowTheme(PocketWindow source, object palette)
        {
            if (source == window) { Report("window.theme", new { generation = pageGeneration, palette = palette }); }
        }

        void ApplyTrayAppearance()
        {
            if (windowPrefs.trayStyle == "pocket" && !SystemInformation.HighContrast)
            {
                object palette = ShellWire.Get(ShellWire.Get(snapshot, "window"), "theme");
                Color? panel = PocketWindow.ReadColor(ShellWire.Text(palette, "panel"));
                Color? text = PocketWindow.ReadColor(ShellWire.Text(palette, "text"));
                if (panel.HasValue && text.HasValue)
                {
                    trayMenu.Renderer = new ToolStripProfessionalRenderer(new TrayColors(panel.Value, text.Value));
                    trayMenu.ForeColor = text.Value;
                    return;
                }
            }
            trayMenu.RenderMode = ToolStripRenderMode.System;
            trayMenu.ForeColor = SystemColors.MenuText;
        }
    }

    sealed class TrayColors : ProfessionalColorTable
    {
        readonly Color panel, selection;

        internal TrayColors(Color panel, Color text)
        {
            this.panel = panel;
            selection = Color.FromArgb((panel.R * 4 + text.R) / 5, (panel.G * 4 + text.G) / 5, (panel.B * 4 + text.B) / 5);
        }

        public override Color ToolStripDropDownBackground { get { return panel; } }
        public override Color ImageMarginGradientBegin { get { return panel; } }
        public override Color ImageMarginGradientMiddle { get { return panel; } }
        public override Color ImageMarginGradientEnd { get { return panel; } }
        public override Color MenuItemSelected { get { return selection; } }
        public override Color MenuItemBorder { get { return selection; } }
        public override Color MenuBorder { get { return selection; } }
        public override Color SeparatorDark { get { return selection; } }
        public override Color SeparatorLight { get { return panel; } }
    }
}
