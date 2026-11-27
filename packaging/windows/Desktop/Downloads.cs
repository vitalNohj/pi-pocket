using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace PiPocket
{
    internal sealed class WindowDownloads : IDisposable
    {
        readonly Form owner;
        readonly string origin;
        readonly Action<string> report;
        readonly List<Transfer> active = new List<Transfer>();
        readonly Stopwatch clock = Stopwatch.StartNew();
        string nextLink;
        long expires;
        bool disposed;

        sealed class Transfer
        {
            public CoreWebView2DownloadOperation Operation;
            public EventHandler<object> Changed;
            public string Stage, Destination, Folder;
            public bool Direct;
        }

        public WindowDownloads(Form owner, string origin, Action<string> report)
        {
            this.owner = owner;
            this.origin = origin;
            this.report = report;
        }

        static string FileRouteName(string url, string origin)
        {
            if (!PocketWindow.IsServerAddress(url, origin)) { return null; }
            Uri address = new Uri(url);
            if (address.Fragment.Length != 0 || !Regex.IsMatch(address.AbsolutePath, @"\A/api/c/[0-9]+/download\z")) { return null; }

            string path = null;
            foreach (string item in address.Query.TrimStart('?').Split('&'))
            {
                string[] pair = item.Split(new[] { '=' }, 2);
                if (System.Net.WebUtility.UrlDecode(pair[0]) != "path") { continue; }
                if (path != null || pair.Length != 2 || pair[1].Length == 0) { return null; }
                path = System.Net.WebUtility.UrlDecode(pair[1]);
            }
            return path == null ? null : SafeName(path.Substring(Math.Max(path.LastIndexOf('/'), path.LastIndexOf('\\')) + 1));
        }

        public void LinkActivated(string address)
        {
            if (address != null && FileRouteName(address, origin) != null)
            {
                nextLink = address;
                expires = clock.ElapsedMilliseconds + 5000;
            }
        }

        public void Navigating(CoreWebView2NavigationStartingEventArgs args)
        {
            // If WebView2 cannot prove the original URL (for example, on a redirect), keep the dialog.
            if (args.IsRedirected || args.Uri != nextLink) { nextLink = null; }
        }

        public void Start(object sender, CoreWebView2DownloadStartingEventArgs args)
        {
            var deferral = args.GetDeferral();

            // Do not run the dialog's nested message loop in a WebView2 callback.
            owner.BeginInvoke((MethodInvoker)delegate
            {
                args.Handled = true;
                try
                {
                    if (disposed) { args.Cancel = true; return; }
                    string address = args.DownloadOperation.Uri;
                    string name = nextLink == address && clock.ElapsedMilliseconds <= expires ? FileRouteName(address, origin) : null;
                    nextLink = null;
                    ChooseDestination(args, name);
                }
                catch (IOException) { CannotSave(args); }
                catch (UnauthorizedAccessException) { CannotSave(args); }
                catch (ArgumentException) { CannotSave(args); }
                catch (COMException) { CannotSave(args); }
                finally { deferral.Complete(); }
            });
        }

        void CannotSave(CoreWebView2DownloadStartingEventArgs args)
        {
            args.Cancel = true;
            report("Could not save the download.");
        }

        void ChooseDestination(CoreWebView2DownloadStartingEventArgs args, string routeName)
        {
            bool direct = routeName != null;
            string folder = DownloadsFolder();
            // The browser can suggest a name it has already made unique. Start with the file's own name instead.
            string name = routeName ?? SafeName(Path.GetFileName(args.ResultFilePath));
            string path = Path.Combine(folder, name);

            if (!direct)
            {
                using (var dialog = new SaveFileDialog { FileName = name, InitialDirectory = folder, OverwritePrompt = true })
                {
                    if (dialog.ShowDialog(owner) != DialogResult.OK) { args.Cancel = true; return; }
                    path = dialog.FileName;
                    folder = Path.GetDirectoryName(path);
                }
            }

            if (disposed) { args.Cancel = true; return; }
            Directory.CreateDirectory(folder);
            // WebView2 may write and clean up a partial file. Let it touch only a fresh name that we own.
            string stageFolder = Path.Combine(folder, ".pi-pocket-download-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stageFolder);
            var transfer = new Transfer { Operation = args.DownloadOperation, Destination = path, Folder = stageFolder,
                Stage = Path.Combine(stageFolder, name), Direct = direct };
            args.ResultFilePath = transfer.Stage;
            transfer.Changed = delegate { Finish(transfer); };
            transfer.Operation.StateChanged += transfer.Changed;
            active.Add(transfer);
        }

        void Finish(Transfer transfer)
        {
            if (transfer.Operation.State == CoreWebView2DownloadState.InProgress || !active.Remove(transfer)) { return; }
            transfer.Operation.StateChanged -= transfer.Changed;

            try
            {
                if (transfer.Operation.State == CoreWebView2DownloadState.Completed)
                {
                    string path = transfer.Destination;
                    if (transfer.Direct)
                    {
                        path = MoveWithoutReplacing(transfer.Stage, path);
                        try { Process.Start("explorer.exe", "/select,\"" + path + "\""); }
                        catch (System.ComponentModel.Win32Exception) { /* The file is already saved. */ }
                    }
                    else if (File.Exists(path)) { File.Replace(transfer.Stage, path, null); }
                    else { File.Move(transfer.Stage, path); }
                    report("Download saved: " + Path.GetFileName(path));
                }
                else { report("The download did not finish."); }
            }
            catch (IOException) { report("Could not save the download."); }
            catch (UnauthorizedAccessException) { report("Could not save the download."); }
            finally { Clean(transfer); }
        }

        static string MoveWithoutReplacing(string stage, string destination)
        {
            string folder = Path.GetDirectoryName(destination);
            string stem = Path.GetFileNameWithoutExtension(destination);
            string extension = Path.GetExtension(destination);

            for (int suffix = 1; suffix <= 1000; suffix++)
            {
                string path = suffix == 1 ? destination : Path.Combine(folder, stem + " (" + suffix + ")" + extension);
                try { File.Move(stage, path); return path; }
                catch (IOException) { if (!File.Exists(path) && !Directory.Exists(path)) { throw; } }
            }

            throw new IOException("No unused file name.");
        }

        static string SafeName(string name)
        {
            string safe = string.Join("_", (name ?? "").Split(Path.GetInvalidFileNameChars())).Trim().TrimEnd('.');
            if (safe.Length == 0) { return "download"; }
            // Win32 device names are reserved even on a file with an extension.
            if (Regex.IsMatch(safe.Split('.')[0].TrimEnd(), @"\A(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])\z", RegexOptions.IgnoreCase))
            {
                return "_" + safe;
            }
            return safe;
        }

        static string DownloadsFolder()
        {
            Guid id = new Guid("374DE290-123F-4565-9164-39C4925E467B"); // FOLDERID_Downloads
            IntPtr path;
            if (SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out path) == 0)
            {
                try { return Marshal.PtrToStringUni(path); }
                finally { Marshal.FreeCoTaskMem(path); }
            }

            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }

        static void Clean(Transfer transfer)
        {
            try { Directory.Delete(transfer.Folder, true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        public void Dispose()
        {
            disposed = true;
            foreach (Transfer transfer in active.ToArray())
            {
                transfer.Operation.StateChanged -= transfer.Changed;
                transfer.Operation.Cancel();
                Clean(transfer);
            }
            active.Clear();
        }

        [DllImport("shell32.dll")]
        static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
    }
}
