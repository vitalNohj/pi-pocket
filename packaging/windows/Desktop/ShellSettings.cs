using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PiPocket
{
    sealed class ShellSettings : Form
    {
        const string Host = "desktop-settings.invalid";
        const string Address = "https://" + Host + "/index.html";
        readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill };
        readonly Func<string, object, Task<object>> call;
        bool committed;
        bool loaded;
        string section = "home";
        public CoreWebView2 Browser { get { return view.CoreWebView2; } }

        public ShellSettings(Icon icon, Func<string, object, Task<object>> call)
        {
            this.call = call;
            Text = "Desktop Settings — Pi Pocket";
            Icon = icon;
            Size = new Size(930, 710);
            MinimumSize = new Size(490, 500);
            StartPosition = FormStartPosition.CenterScreen;
            Controls.Add(view);
        }

        public async Task Initialize(TrayApp host, string assets)
        {
            await host.InitializeWebView(view, ShellWebProfile.Settings);
            if (IsDisposed) { return; }
            CoreWebView2 core = Browser;

            view.AllowExternalDrop = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultScriptDialogsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.SetVirtualHostNameToFolderMapping(Host, assets, CoreWebView2HostResourceAccessKind.Deny);
            core.NavigationStarting += delegate (object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                e.Cancel = e.Uri != Address;
                if (!e.Cancel) { committed = loaded = false; }
            };
            core.ContentLoading += delegate (object sender, CoreWebView2ContentLoadingEventArgs e)
            {
                committed = !e.IsErrorPage && core.Source == Address;
            };
            core.NavigationCompleted += delegate (object sender, CoreWebView2NavigationCompletedEventArgs e)
            {
                loaded = committed && e.IsSuccess;
                SelectSection(section);
            };
            core.FrameNavigationStarting += delegate (object sender, CoreWebView2NavigationStartingEventArgs e) { e.Cancel = true; };
            core.NewWindowRequested += delegate (object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
            core.DownloadStarting += delegate (object sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; };
            core.PermissionRequested += delegate (object sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
            core.WebMessageReceived += Receive;
            core.Navigate(Address);
        }

        public void SelectSection(string next)
        {
            section = next ?? section;
            if (loaded) { Send(new { v = 1, type = "section", section = section }); }
        }

        public void UpdateState(object state)
        {
            Send(new { v = 1, type = "state", state = state });
        }

        async void Receive(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            if (!committed || args.Source != Address || Browser.Source != Address ||
                Encoding.UTF8.GetByteCount(args.WebMessageAsJson) > ShellWire.MaxBytes) { return; }
            Dictionary<string, object> packet;

            try { packet = ShellWire.Serializer().Deserialize<Dictionary<string, object>>(args.WebMessageAsJson); }
            catch (ArgumentException) { return; }
            catch (InvalidOperationException) { return; }
            int id = ShellWire.Number(packet, "id");
            string command = ShellWire.Text(packet, "command");

            if (id <= 0 || ShellWire.Number(packet, "v") != 1 ||
                !new[] { "getState", "subscribe", "action", "patchPreferences" }.ContainsCommand(command)) { return; }
            try
            {
                object result = await call(command, ShellWire.Get(packet, "value"));
                Send(new { v = 1, type = "result", id = id, ok = true, value = result });
            }
            catch (InvalidOperationException error)
            {
                Send(new { v = 1, type = "result", id = id, ok = false, error = new { message = error.Message } });
            }
        }

        void Send(object packet)
        {
            if (committed && !IsDisposed && Browser != null && Browser.Source == Address)
            {
                Browser.PostWebMessageAsJson(ShellWire.Serializer().Serialize(packet));
            }
        }
    }

    static class ShellSettingsCommands
    {
        public static bool ContainsCommand(this string[] commands, string command)
        {
            return Array.IndexOf(commands, command) >= 0;
        }
    }
}
