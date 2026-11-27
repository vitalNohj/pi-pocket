using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PiPocket
{
    enum ShellWebProfile { Local, Remote, Settings }

    sealed partial class TrayApp
    {
        Task<CoreWebView2Environment> webEnvironment;
        string webDataFolder;
        ShellWebProfile SessionWebProfile { get { return localPage ? ShellWebProfile.Local : ShellWebProfile.Remote; } }

        // All windows share one browser environment. Keep the local owner's old Default profile and give remote
        // servers their own cookie store. Settings only loads bundled assets and uses a separate private profile.
        internal async Task InitializeWebView(WebView2 view, ShellWebProfile profile)
        {
            string stage = "environment";
            try
            {
                Form form = view.FindForm();
                if (ui.InvokeRequired || Thread.CurrentThread.GetApartmentState() != ApartmentState.STA ||
                    form == null || !form.IsHandleCreated)
                {
                    throw new InvalidOperationException("The WebView2 control must have a window on the UI thread.");
                }

                GC.KeepAlive(view.Handle);
                if (webEnvironment == null || webEnvironment.IsFaulted || webEnvironment.IsCanceled)
                {
                    CoreWebView2Environment.GetAvailableBrowserVersionString(null);
                    WriteWebViewLog("Creating the WebView2 environment.");
                    webEnvironment = CoreWebView2Environment.CreateAsync(null, webDataFolder);
                }

                CoreWebView2Environment environment = await webEnvironment;
                if (view.IsDisposed) { return; }
                stage = "controller";
                WriteWebViewLog("Creating the " + profile + " WebView2 controller.");
                CoreWebView2ControllerOptions options = environment.CreateCoreWebView2ControllerOptions();
                if (profile != ShellWebProfile.Local) { options.ProfileName = profile.ToString(); }
                options.IsInPrivateModeEnabled = profile == ShellWebProfile.Settings;
                if (profile != ShellWebProfile.Settings)
                {
                    try { options.AllowHostInputProcessing = true; }
                    catch (NotImplementedException) { /* Older runtimes still have the menus. */ }
                }
                await view.EnsureCoreWebView2Async(environment, options);
                WriteWebViewLog("The " + profile + " WebView2 controller is ready.");
            }
            catch (Exception error)
            {
                if (!quitting && !view.IsDisposed) { ReportWebViewFailure(profile, stage, error); }
                throw;
            }
        }

        internal void ReportWebViewFailure(ShellWebProfile profile, string stage, Exception error)
        {
            WriteWebViewLog(string.Format("WebView2 {0} {1} failed: 0x{2:X8}; user data folder: {3}",
                profile, stage, error.HResult, webDataFolder));
        }

        internal void WriteWebViewLog(string message)
        {
            Log(message);
            try
            {
                Directory.CreateDirectory(stateFolder);
                string path = Path.Combine(stateFolder, "webview2.log");
                if (File.Exists(path) && new FileInfo(path).Length >= 64 * 1024) { File.Delete(path); }
                File.AppendAllText(path, DateTime.UtcNow.ToString("u") + " " + message + Environment.NewLine);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
