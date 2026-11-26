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
                    webEnvironment = CoreWebView2Environment.CreateAsync(null, webDataFolder);
                }

                CoreWebView2Environment environment = await webEnvironment;
                if (view.IsDisposed) { return; }
                stage = "controller";
                if (profile == ShellWebProfile.Local)
                {
                    await view.EnsureCoreWebView2Async(environment);
                }
                else
                {
                    CoreWebView2ControllerOptions options = environment.CreateCoreWebView2ControllerOptions();
                    options.ProfileName = profile.ToString();
                    options.IsInPrivateModeEnabled = profile == ShellWebProfile.Settings;
                    await view.EnsureCoreWebView2Async(environment, options);
                }
            }
            catch (Exception error)
            {
                if (!quitting && !view.IsDisposed)
                {
                    string message = string.Format("WebView2 {0} {1} failed: 0x{2:X8}; user data folder: {3}",
                        profile, stage, error.HResult, webDataFolder);
                    Log(message);
                    Console.Error.WriteLine(message);
                    string folder = stateFolder;
                    ThreadPool.QueueUserWorkItem(delegate
                    {
                        try
                        {
                            Directory.CreateDirectory(folder);
                            File.AppendAllText(Path.Combine(folder, "webview2.log"), message + Environment.NewLine);
                        }
                        catch (IOException) { }
                        catch (UnauthorizedAccessException) { }
                    });
                }
                throw;
            }
        }
    }
}
