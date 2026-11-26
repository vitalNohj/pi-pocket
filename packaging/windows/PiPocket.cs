// Pi Pocket.exe: the Windows desktop app. A notification area icon and a WebView2 window around a `pi-pocket.js --desktop` launcher.
//
// build.ps1 compiles it with the .NET Framework 4.x compiler that every Windows 10 and 11 has, so this is C# 5.
// The owner token goes only in a header of a request to this PC: never on a command line, in a title, or in the log.
// A newer pi-pocket package replaces nothing here, so this app uses only --desktop, launcher-running.json,
// /api/pocket/info, /api/sign-in-link, and /api/restart.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

[assembly: AssemblyTitle("Pi Pocket")]
[assembly: AssemblyProduct("Pi Pocket")]
[assembly: AssemblyDescription("Pi Pocket")]
[assembly: AssemblyCompany("Tanner Middleton")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Tanner Middleton. MIT License.")]
[assembly: AssemblyVersion(PiPocket.Program.NumericVersion)]
[assembly: AssemblyFileVersion(PiPocket.Program.NumericVersion)]
[assembly: AssemblyInformationalVersion(PiPocket.Program.Version)]

namespace PiPocket
{
    static class Native
    {
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        public const int ASFW_ANY = -1;
        public const int SW_RESTORE = 9;

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("user32.dll")]
        public static extern bool AllowSetForegroundWindow(int processId);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll")]
        public static extern IntPtr GetWindow(IntPtr window, uint command);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc each, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);
    }

    static class Program
    {
        // build.ps1 puts the installer's version in place of these.
        public const string Version = "0.0.0-dev";
        public const string NumericVersion = "0.0.0.0";
        const string MutexName = @"Local\Pi Pocket desktop app";
        public const string OpenEventName = @"Local\Pi Pocket desktop app: open";
        public const string QuitEventName = @"Local\Pi Pocket desktop app: quit";

        [STAThread]
        static int Main(string[] args)
        {
            bool hidden = Array.IndexOf(args, "--hidden") >= 0;
            bool quit = Array.IndexOf(args, "--quit") >= 0;
            bool first;

            using (Mutex mutex = new Mutex(true, MutexName, out first))
            {
                if (quit)
                {
                    return first ? 0 : Signal(QuitEventName);
                }

                if (!first)
                {
                    // The running one opens its window. This process got the click, so it may hand the foreground on.
                    if (!hidden)
                    {
                        Native.AllowSetForegroundWindow(Native.ASFW_ANY);
                        Signal(OpenEventName);
                    }

                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                TrayApp app = new TrayApp(hidden);
                Application.Run(app);
                GC.KeepAlive(mutex);

                return 0;
            }
        }

/// Same order as CompareVersions in pi-pocket.iss.
        public static int CompareVersions(string a, string b)
        {
            string[] left = a.Split('+')[0].Split(new char[] { '-' }, 2);
            string[] right = b.Split('+')[0].Split(new char[] { '-' }, 2);
            string[] leftCore = left[0].Split('.');
            string[] rightCore = right[0].Split('.');

            for (int index = 0; index < 3; index++)
            {
                long x = index < leftCore.Length ? Number(leftCore[index]) : 0;
                long y = index < rightCore.Length ? Number(rightCore[index]) : 0;

                if (x != y)
                {
                    return x < y ? -1 : 1;
                }
            }

            if (left.Length == 1 || right.Length == 1)
            {
                return left.Length == right.Length ? 0 : (left.Length == 1 ? 1 : -1);
            }

            string[] leftPre = left[1].Split('.');
            string[] rightPre = right[1].Split('.');

            for (int index = 0; index < Math.Max(leftPre.Length, rightPre.Length); index++)
            {
                if (index >= leftPre.Length || index >= rightPre.Length)
                {
                    return index >= leftPre.Length ? -1 : 1;
                }

                string x = leftPre[index];
                string y = rightPre[index];
                int order = Digits(x) && Digits(y)
                    ? Number(x).CompareTo(Number(y))
                    : string.CompareOrdinal(x, y);

                if (order != 0)
                {
                    return order < 0 ? -1 : 1;
                }
            }

            return 0;
        }

        static bool Digits(string text)
        {
            if (text.Length == 0)
            {
                return false;
            }

            foreach (char each in text)
            {
                if (each < '0' || each > '9')
                {
                    return false;
                }
            }

            return true;
        }

        static long Number(string text)
        {
            long value;

            return long.TryParse(text, System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out value) ? value : 0;
        }

        static int Signal(string name)
        {
            try
            {
                using (EventWaitHandle signal = EventWaitHandle.OpenExisting(name))
                {
                    signal.Set();
                }

                return 0;
            }
            catch (Exception)
            {
                // The other one is just starting or stopping.
                return 1;
            }
        }
    }

    sealed partial class TrayApp : ApplicationContext
    {
        readonly string appDir = Path.GetDirectoryName(Application.ExecutablePath);
        readonly string dataDir;
        readonly string logFile;
        readonly object logLock = new object();
        readonly NotifyIcon tray = new NotifyIcon();
        readonly Control ui = new Control();
        readonly EventWaitHandle openEvent;
        readonly EventWaitHandle quitEvent;
        IntPtr job = IntPtr.Zero;
        StreamWriter log;
        Process launcher;
        Process edge;
        string url;
        bool ready;
        bool openWhenReady;
        volatile bool quitting;
        bool openingWindow;
        bool edgeFallback;
        PocketWindow window;
        readonly List<PocketWindow> popups = new List<PocketWindow>();
        readonly Queue<Action> balloons = new Queue<Action>();
        int badge;
        bool balloonActive;
        string balloonAddress;

        public TrayApp(bool hidden)
        {
            string data = Environment.GetEnvironmentVariable("PI_POCKET_DIR");
            dataDir = string.IsNullOrEmpty(data)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pi-pocket")
                : Path.GetFullPath(data);
            logFile = Path.Combine(appDir, "launcher.log");
            openWhenReady = !hidden;
            // The handle that BeginInvoke needs, made on this thread.
            ui.CreateControl();
            GC.KeepAlive(ui.Handle);

            string icon = Path.Combine(appDir, "pi-pocket.ico");
            tray.Icon = File.Exists(icon)
                ? new Icon(icon, SystemInformation.SmallIconSize)
                : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            tray.Text = "Pi Pocket (starting)";
            MakeTrayMenu();
            tray.MouseClick += delegate (object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left)
                {
                    OpenWindow();
                }
            };
            tray.BalloonTipClicked += delegate
            {
                string address = balloonAddress;
                ClearBalloon();

                if (!quitting && address != null && window != null)
                {
                    window.ShowWindow();
                    window.OpenAddress(address);
                }
            };
            tray.BalloonTipClosed += delegate { ClearBalloon(); };
            tray.Visible = true;

            openEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.OpenEventName);
            quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.QuitEventName);
            Thread listener = new Thread(delegate ()
            {
                for (;;)
                {
                    if (WaitHandle.WaitAny(new WaitHandle[] { openEvent, quitEvent }) == 0)
                    {
                        OnUi(delegate { OpenWindow(); });
                    }
                    else
                    {
                        OnUi(delegate { Quit(); });
                    }
                }
            });
            listener.IsBackground = true;
            listener.Start();

            OnUi(StartShell);
        }

        void OnUi(MethodInvoker action)
        {
            try
            {
                ui.BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // The app is closing.
            }
        }

        internal void Log(string line)
        {
            lock (logLock)
            {
                if (log != null)
                {
                    log.WriteLine(line);
                }
            }
        }

        void OpenLog()
        {
            if (log != null) { return; }
            try
            {
                if (File.Exists(logFile))
                {
                    File.Copy(logFile, Path.Combine(appDir, "launcher.old.log"), true);
                }
            }
            catch (IOException)
            {
                // The new log matters more than the old one.
            }

            StreamWriter writer = new StreamWriter(logFile, false, new UTF8Encoding(false));
            writer.AutoFlush = true;

            lock (logLock)
            {
                log = writer;
            }

            Log("Pi Pocket desktop app " + Program.Version + ", " + DateTime.Now.ToString("u"));
        }

/// Setup writes app\setup-finished.txt after it copied the package: without it, the copy stopped. An older package
/// than this app is one Setup did not replace: an older launcher refuses --desktop.
        string[] PackageProblem()
        {
            string folder = Path.Combine(appDir, @"app\node_modules\pi-pocket");
            string again = "Run Pi Pocket Setup " + Program.Version + " again. Your sessions and settings stay.";
            string version = null;

            try
            {
                if (File.Exists(Path.Combine(folder, @"bin\pi-pocket.js")))
                {
                    Dictionary<string, object> manifest = new JavaScriptSerializer()
                        .Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(folder, "package.json")));
                    object value;
                    version = manifest.TryGetValue("version", out value) ? value as string : null;
                }
            }
            catch (Exception)
            {
                version = null;
            }

            if (version == null || !File.Exists(Path.Combine(appDir, @"app\setup-finished.txt")))
            {
                return new string[]
                {
                    "Pi Pocket is not fully installed: Setup did not finish putting the pi-pocket package in " +
                        folder + ".",
                    again
                };
            }

            if (!string.Equals(Program.Version, "0.0.0-dev") && Program.CompareVersions(version, Program.Version) < 0)
            {
                return new string[]
                {
                    "The pi-pocket package of Pi Pocket is version " + version + ", older than this app (" +
                        Program.Version + ").",
                    "Setup did not finish putting the package in place, so Pi Pocket cannot start. " + again
                };
            }

            return null;
        }

        void StartLauncher()
        {
            string node = Path.Combine(appDir, @"node\node.exe");
            string script = Path.Combine(appDir, @"app\node_modules\pi-pocket\bin\pi-pocket.js");

            if (!File.Exists(node) || !File.Exists(script))
            {
                throw new FileNotFoundException("Pi Pocket is not fully installed. Run Setup again.", script);
            }

            ProcessStartInfo start = new ProcessStartInfo(node, Quote(script) + " --desktop --data " + Quote(dataDir));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.StandardErrorEncoding = Encoding.UTF8;
            start.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            start.EnvironmentVariables["NPM_CONFIG_PREFIX"] = Path.Combine(appDir, "app");
            start.EnvironmentVariables["NPM_CONFIG_CACHE"] = Path.Combine(appDir, "npm-cache");
            start.EnvironmentVariables["NPM_CONFIG_UPDATE_NOTIFIER"] = "false";
            start.EnvironmentVariables["NO_COLOR"] = "1";
            start.EnvironmentVariables["PATH"] = Path.Combine(appDir, "node") + ";" + Path.Combine(appDir, "app") + ";" +
                start.EnvironmentVariables["PATH"];

            launcher = new Process();
            launcher.StartInfo = start;
            launcher.EnableRaisingEvents = true;
            launcher.OutputDataReceived += delegate (object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null)
                {
                    Log(e.Data);
                }
            };
            launcher.ErrorDataReceived += delegate (object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null)
                {
                    Log(e.Data);
                }
            };
            launcher.Exited += delegate (object sender, EventArgs args)
            {
                Process ended = (Process)sender;
                OnUi(delegate { LauncherExited(ended); });
            };
            launcher.Start();
            // At once, before the launcher starts the server: the server and every command that it runs join the job.
            AddToJob(launcher);
            launcher.BeginOutputReadLine();
            launcher.BeginErrorReadLine();
        }

/// Ends every process in it when this app ends, also when it crashes. This app is not in it: the default browser stays.
        void AddToJob(Process process)
        {
            if (job == IntPtr.Zero)
            {
                job = Native.CreateJobObject(IntPtr.Zero, null);

                if (job == IntPtr.Zero)
                {
                    throw new Win32Exception();
                }

                Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref info,
                    Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                {
                    throw new Win32Exception();
                }
            }

            if (!Native.AssignProcessToJobObject(job, process.Handle))
            {
                Log("Could not add process " + process.Id + " to the job: " + new Win32Exception().Message);
            }
        }

        void LauncherExited(Process ended)
        {
            if (quitting || stoppingLocal || ended != launcher) { return; }
            int code = ended.ExitCode;
            string message = "The local launcher stopped (exit code " + code + "). Check the server log.";
            Log(message);
            Report("local", Local("error", false, false, null, message));
        }

        void Quit()
        {
            if (quitting)
            {
                return;
            }

            quitting = true;
            tray.Visible = false;
            Stop();
        }

        void Stop()
        {
            if (controller != null) { controller.Dispose(); }
            if (settings != null) { settings.Dispose(); }
            CloseWindows();
            Thread stop = new Thread(delegate ()
            {
                try
                {
                    StopLocal();
                }
                catch (Exception)
                {
                    // The job ends what is left.
                }

                OnUi(Exit);
            });
            stop.IsBackground = true;
            stop.Start();
        }

        void Exit()
        {
            quitting = true;
            CloseWindows();
            tray.Visible = false;
            tray.Dispose();

            lock (logLock)
            {
                if (log != null)
                {
                    log.Dispose();
                    log = null;
                }
            }

            ExitThread();
        }

        async void OpenWindow()
        {
            if (quitting)
            {
                return;
            }

            if (!ready)
            {
                openWhenReady = true;
                OpenSettings("home");
                return;
            }

            if (edgeFallback)
            {
                OpenEdge();

                return;
            }

            if (window != null)
            {
                window.ShowWindow();

                return;
            }

            if (openingWindow)
            {
                return;
            }

            openingWindow = true;
            int generation = pageGeneration;
            PocketWindow made = null;

            try
            {
                made = new PocketWindow(this, url, tray.Icon, Path.Combine(appDir, "window-bounds.txt"));
                window = made;
                made.Disposed += delegate { if (window == made) { window = null; } };
                made.ShowWindow();
                if (pendingSession) { pendingSession = false; made.NewSession(); }
                await made.Initialize(SessionWebProfile);
                if (quitting || made.IsDisposed || generation != pageGeneration) { return; }
                string target = localPage ? await Task.Run(() => LocalSignInAddress(url, localPid)) : pageAddress;
                if (!quitting && !made.IsDisposed && generation == pageGeneration) { made.Browser.Navigate(target); }
            }
            catch (WebView2RuntimeNotFoundException)
            {
                if (generation == pageGeneration && !quitting)
                {
                    CloseWindows();
                    edgeFallback = true;
                    Log("The WebView2 Runtime is missing. Opening Pi Pocket in Microsoft Edge instead.");
                    OpenEdge();
                }
            }
            catch (Exception error)
            {
                if (generation == pageGeneration && !quitting)
                {
                    CloseWindows();
                    Log("Could not open the WebView2 window (" + error.GetType().Name + ").");
                    OpenSettings("home");
                }
            }
            finally
            {
                openingWindow = false;
                if (!quitting && ready && generation != pageGeneration && window == null) { OpenWindow(); }
            }
        }

        async Task NewSessionWindow()
        {
            if (!ready || quitting) { return; }
            PocketWindow made = new PocketWindow(this, url, tray.Icon, null);
            popups.Add(made);
            made.Disposed += delegate { popups.Remove(made); };
            made.ShowWindow();
            try
            {
                await made.Initialize(SessionWebProfile);
                if (!quitting && !made.IsDisposed) { made.Browser.Navigate(pageAddress); }
            }
            catch (Exception) { made.Dispose(); }
        }

        internal async void NewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs args)
        {
            args.Handled = true;

            if (quitting)
            {
                return;
            }

            if (!PocketWindow.IsServerAddress(args.Uri, url))
            {
                if (args.IsUserInitiated)
                {
                    OpenInDefaultBrowser(args.Uri);
                }

                return;
            }

            CoreWebView2Deferral deferral = args.GetDeferral();
            PocketWindow popup = null;

            try
            {
                popup = new PocketWindow(this, url, tray.Icon, null);
                popups.Add(popup);
                popup.Disposed += delegate { popups.Remove(popup); };
                popup.ShowWindow();
                await popup.Initialize(SessionWebProfile);

                if (!quitting && !popup.IsDisposed)
                {
                    // It must share the same environment and profile, and not have navigated yet.
                    args.NewWindow = popup.Browser;
                }
            }
            catch (Exception)
            {
                if (popup != null)
                {
                    popup.Dispose();
                }

                if (!quitting)
                {
                    Log("Could not open a second WebView2 window.");
                }
            }
            finally
            {
                deferral.Complete();
            }
        }

        void CloseWindows()
        {
            if (window != null)
            {
                window.SaveBounds();
                window.Dispose();
                window = null;
            }

            foreach (PocketWindow popup in popups.ToArray())
            {
                popup.Dispose();
            }
        }

        internal int Badge { get { return badge; } }

        internal void SetBadge(int count)
        {
            if (quitting || count == badge)
            {
                return;
            }

            badge = count;
            UpdateTrayText();

            if (window != null)
            {
                window.UpdateBadge();
            }

            foreach (PocketWindow popup in popups)
            {
                popup.UpdateBadge();
            }
        }

        void UpdateTrayText()
        {
            string name = localPage && launcher == null ? "Pi Pocket (started by another launcher)" : "Pi Pocket";
            tray.Text = badge > 0 ? name + " (" + badge + " need you)" : name;
        }

        internal void Notify(string title, string body, string address)
        {
            Uri target;

            if (!quitting && NotificationsEnabled && url != null && Uri.TryCreate(new Uri(url), address, out target) && PocketWindow.IsServerAddress(target.AbsoluteUri, url))
            {
                ShowBalloon(title, body, ToolTipIcon.Info, target.PathAndQuery);
            }
        }

        void ShowBalloon(string title, string body, ToolTipIcon icon, string address)
        {
            // WinForms reports a click on the icon, not the balloon's ID. Wait until it closes before showing the next.
            if (balloons.Count == 8)
            {
                balloons.Dequeue();
            }

            balloons.Enqueue(delegate
            {
                balloonAddress = address;
                tray.ShowBalloonTip(5000, title, string.IsNullOrWhiteSpace(body) ? "Pi Pocket" : body, icon);
            });
            ShowNextBalloon();
        }

        void ShowNextBalloon()
        {
            if (!quitting && !balloonActive && balloons.Count != 0)
            {
                balloonActive = true;
                balloons.Dequeue()();
            }
        }

        void ClearBalloon()
        {
            balloonAddress = null;
            balloonActive = false;
            OnUi(ShowNextBalloon);
        }

        void OpenEdge()
        {
            if (FocusEdge())
            {
                return;
            }

            // The shell starts Edge with an address on its command line. Never give it a credential or a sign-in code.
            string target = pageAddress;
            string msedge = FindEdge();

            if (msedge != null)
            {
                string profile = Path.Combine(appDir, "Edge profile");
                ProcessStartInfo start = new ProcessStartInfo(msedge, Quote("--app=" + target) + " " +
                    Quote("--user-data-dir=" + profile) + " --no-first-run --no-default-browser-check");
                start.UseShellExecute = false;

                try
                {
                    Process started = Process.Start(start);

                    if (edge == null || edge.HasExited)
                    {
                        edge = started;
                        AddToJob(edge);
                    }

                    return;
                }
                catch (Exception error)
                {
                    Log("Could not start Edge: " + error.Message);
                }
            }

            OpenInDefaultBrowser(target);
        }

        bool FocusEdge()
        {
            if (edge == null || edge.HasExited)
            {
                return false;
            }

            IntPtr found = IntPtr.Zero;
            int id = edge.Id;
            Native.EnumWindows(delegate (IntPtr window, IntPtr unused)
            {
                int owner;
                Native.GetWindowThreadProcessId(window, out owner);

                if (owner == id && Native.IsWindowVisible(window) && Native.GetWindow(window, 4) == IntPtr.Zero)
                {
                    found = window;

                    return false;
                }

                return true;
            }, IntPtr.Zero);

            if (found == IntPtr.Zero)
            {
                return false;
            }

            if (Native.IsIconic(found))
            {
                Native.ShowWindow(found, Native.SW_RESTORE);
            }

            Native.SetForegroundWindow(found);

            return true;
        }

        static string FindEdge()
        {
            string[] keys =
            {
                @"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
                @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
                @"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
            };

            foreach (string key in keys)
            {
                string path = Registry.GetValue(key, "", null) as string;

                if (!string.IsNullOrEmpty(path) && File.Exists(path.Trim('"')))
                {
                    return path.Trim('"');
                }
            }

            foreach (Environment.SpecialFolder folder in new[]
            {
                Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.ProgramFiles,
            })
            {
                string path = Path.Combine(Environment.GetFolderPath(folder), @"Microsoft\Edge\Application\msedge.exe");

                if (File.Exists(path))
                {
                    return path;
                }
            }

            return null;
        }

        internal void OpenInDefaultBrowser(string target)
        {
            Uri address;

            if (!Uri.TryCreate(target, UriKind.Absolute, out address) || address.UserInfo.Length != 0 ||
                (address.Scheme != Uri.UriSchemeHttp && address.Scheme != Uri.UriSchemeHttps && address.Scheme != Uri.UriSchemeMailto))
            {
                return;
            }

            try
            {
                Process.Start(new ProcessStartInfo(address.AbsoluteUri) { UseShellExecute = true });
            }
            catch (Exception)
            {
                Log("Could not open the default browser.");
            }
        }

        string OwnerToken()
        {
            Dictionary<string, object> config = new JavaScriptSerializer()
                .Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(dataDir, "config.json")));
            object token;

            if (!config.TryGetValue("ownerToken", out token) || !(token is string))
            {
                throw new InvalidDataException("config.json has no owner token");
            }

            return (string)token;
        }

/// Never through a proxy.
        static string Request(string method, string address, string token)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(address);
            request.Method = method;
            request.Proxy = null;
            request.Timeout = 10000;
            request.ReadWriteTimeout = 10000;
            request.AllowAutoRedirect = false;

            if (token != null)
            {
                request.Headers["Authorization"] = "Bearer " + token;
            }

            if (method != "GET")
            {
                request.Headers["X-Pocket"] = "1";
                request.ContentType = "application/json";
                byte[] body = Encoding.UTF8.GetBytes("{}");
                request.ContentLength = body.Length;

                using (Stream stream = request.GetRequestStream())
                {
                    stream.Write(body, 0, body.Length);
                }
            }

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                char[] text = new char[16385];
                int size = reader.ReadBlock(text, 0, text.Length);
                if (size == text.Length) { throw new InvalidDataException("The local server response is too large."); }
                return new string(text, 0, size);
            }
        }

        static string Quote(string argument)
        {
            StringBuilder quoted = new StringBuilder("\"");
            int slashes = 0;

            foreach (char each in argument)
            {
                if (each == '\\')
                {
                    slashes++;

                    continue;
                }

                quoted.Append('\\', each == '"' ? slashes * 2 + 1 : slashes);
                slashes = 0;
                quoted.Append(each);
            }

            quoted.Append('\\', slashes * 2);

            return quoted.Append('"').ToString();
        }
    }
}
