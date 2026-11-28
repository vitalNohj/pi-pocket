using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Text;
using System.Windows.Forms;

namespace PiPocket
{
    sealed partial class TrayApp
    {
        readonly object launcherGate = new object();
        volatile bool stoppingLocal;
        LocalLaunch launcherSettings;
        LocalListener local;

        sealed class LocalLaunch
        {
            public readonly string Data, Folder, Access;
            public readonly int Port;

            public LocalLaunch(object fields)
            {
                Data = ShellWire.Text(fields, "data");
                Folder = ShellWire.Text(fields, "cwd");
                Port = ShellWire.Number(fields, "port");
                Access = ShellWire.Text(fields, "access");
                if (string.IsNullOrEmpty(Data) || string.IsNullOrEmpty(Folder) || Port < 1 || Port > 65535 ||
                    (Access != "local" && Access != "lan" && Access != "tailscale" && Access != "cloudflare"))
                {
                    throw new InvalidOperationException("The local server settings are invalid.");
                }
            }

            public object Snapshot() { return new { data = Data, cwd = Folder, port = Port, access = Access }; }
        }

        sealed class LocalListener
        {
            public readonly string Data, Address;
            public readonly int Pid;
            public readonly bool Verified;

            public LocalListener(string data, string address, int pid, bool verified)
            {
                Data = data;
                Address = address;
                Pid = pid;
                Verified = verified;
            }
        }

        bool HasLocalLauncher { get { return launcher != null && !launcher.HasExited; } }

        object Local(string status, bool owned, bool verified, string address = null, string message = null)
        {
            var value = new Dictionary<string, object> { { "status", status }, { "owned", owned }, { "verified", verified } };

            if (address != null) { value.Add("address", address); }
            if (message != null) { value.Add("message", message); }
            return value;
        }

        object ReuseLocal(string data)
        {
            int pid;
            bool verified;
            bool owned = HasLocalLauncher;
            string root = owned ? launcherSettings.Data : data;
            string address = RunningAddress(root, owned ? launcher.Id : -1, out pid, out verified);
            return address == null ? null : ReadyLocal(root, address, pid, verified, owned ? launcherSettings : null);
        }

        object ReadyLocal(string data, string address, int pid, bool verified, LocalLaunch settings)
        {
            local = new LocalListener(data, address, pid, verified);
            var value = (Dictionary<string, object>)Local("running", settings != null, verified, address,
                verified ? null : "The app could not verify the listener. Sign in on the page as you would in a browser.");
            if (settings != null) { value["settings"] = settings.Snapshot(); }
            return value;
        }

        object InspectLocal(string data)
        {
            lock (launcherGate) { return ReuseLocal(data) ?? Local("stopped", false, false); }
        }

        object OpenLocal(object request)
        {
            var wanted = new LocalLaunch(ShellWire.Get(request, "settings"));
            bool replace = ShellWire.Flag(request, "replace");
            Process started;
            LocalLaunch settings;
            long logOffset;
            int pid;
            bool verified;
            lock (launcherGate)
            {
                if (quitting) { return Local("stopped", false, false); }
                if (replace)
                {
                    if (!HasLocalLauncher) { throw new InvalidOperationException("Only a server started by this app can apply these settings."); }
                    if (RunningAddress(wanted.Data, -1, out pid, out verified) != null && pid != launcher.Id)
                    {
                        throw new InvalidOperationException("Another launcher is using that data folder. Choose a different folder or stop the other launcher yourself.");
                    }
                }
                else
                {
                    object running = ReuseLocal(wanted.Data);
                    if (running != null) { return running; }
                }

                OpenLog();
                string[] problem = PackageProblem();
                if (problem != null) { return LocalProblem(problem[0] + " " + problem[1]); }
                if (replace) { StopLocal(); }
                logOffset = new FileInfo(logFile).Length;
                try { if (!HasLocalLauncher) { StartLauncher(wanted); } }
                catch (Exception) { return LocalProblem("Pi Pocket could not start. Check the server log or run Setup again."); }
                started = launcher;
                settings = launcherSettings;
            }

            Stopwatch waited = Stopwatch.StartNew();
            while (!quitting && waited.Elapsed.TotalMinutes < 6 && !started.HasExited)
            {
                string address = RunningAddress(settings.Data, started.Id, out pid, out verified);
                if (address != null) { return ReadyLocal(settings.Data, address, pid, verified, settings); }
                Thread.Sleep(250);
            }
            if (started.HasExited) { started.WaitForExit(); } // Drain the launcher diagnostics before reading them.
            return LocalProblem(LauncherStartProblem(settings, logOffset));
        }

        string LauncherStartProblem(LocalLaunch settings, long logOffset)
        {
            // Recognize only a few launcher diagnostics. Never pass log text (which can include paths) to Settings.
            try
            {
                using (var file = new FileStream(logFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var reader = new StreamReader(file, Encoding.UTF8))
                {
                    file.Position = Math.Max(logOffset, file.Length - 8192);
                    string tail = reader.ReadToEnd();
                    if (tail.Contains("Tailscale is not connected on this machine."))
                    { return "Tailscale is not connected. Connect Tailscale, then start Pi Pocket again."; }
                    if (tail.Contains("cloudflared is not installed."))
                    { return "Cloudflare Tunnel needs cloudflared. Install it, then start Pi Pocket again."; }
                    if (tail.Contains("Port " + settings.Port + " is already in use"))
                    { return "The port is in use. Choose a different port or connect to a known server from Another server."; }
                }
            }
            catch (IOException) { }
            return "Pi Pocket did not get ready with these settings. Check the server log.";
        }

        object PickLocalFolder(object data)
        {
            if (settings == null || !settings.Visible) { throw new InvalidOperationException("Open Desktop Settings to choose a folder."); }
            bool forData = ShellWire.Text(data, "kind") == "data";
            string initial = ShellWire.Text(data, "folder");
            using (var picker = new FolderBrowserDialog
            {
                Description = forData ? "Choose the Pi Pocket data folder" : "Choose the default folder for new sessions",
                ShowNewFolderButton = forData,
                SelectedPath = Directory.Exists(initial) ? initial : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            })
            {
                return picker.ShowDialog(settings) == DialogResult.OK ? picker.SelectedPath : null;
            }
        }

        object LocalProblem(string message)
        {
            Log("Error: " + message);
            return Local("error", launcher != null && !launcher.HasExited, false, null, message);
        }

        object StopLocal()
        {
            lock (launcherGate)
            {
                stoppingLocal = true;
                try
                {
                    if (launcher != null && !launcher.HasExited)
                    {
                        launcher.StandardInput.Close();
                        if (!launcher.WaitForExit(20000)) { throw new InvalidOperationException("The launcher is still stopping."); }
                    }
                    launcher = null;
                    launcherSettings = null;
                    local = null;
                    return Local("stopped", false, false);
                }
                finally { stoppingLocal = false; }
            }
        }

        async Task RestartLocal()
        {
            if (restartingServer) { return; }
            restartingServer = true;
            try
            {
                LocalListener server = local;
                if (server == null) { throw new InvalidOperationException("The local server is not running."); }
                if (!HasLocalLauncher || launcher.Id != server.Pid)
                {
                    DialogResult answer = MessageBox.Show("Restart the server started by the console or another launcher?",
                        "Restart Server", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
                    if (answer != DialogResult.OK) { return; }
                }
                await Task.Run(delegate { VerifiedOwnerRequest(server, "/api/restart"); });
                LocalNotice("The server restarts. Running work continues.");
            }
            catch (Exception) { throw new InvalidOperationException("Could not restart the verified local server."); }
            finally { restartingServer = false; }
        }

        string VerifiedOwnerRequest(LocalListener server, string route)
        {
            int found;
            bool verified;
            string running = RunningAddress(server.Data, server.Pid, out found, out verified);

            if (!server.Verified || !verified || found != server.Pid || running != server.Address)
            {
                throw new InvalidOperationException("The local listener is not verified.");
            }
            return Request("POST", server.Address + route, OwnerToken(server.Data));
        }

        string RunningAddress(string data, int expected, out int pid, out bool verified)
        {
            pid = 0;
            verified = false;
            string file = Path.Combine(data, "launcher-running.json");
            try
            {
                FileInfo record = new FileInfo(file);
                if (!record.Exists || record.Length > 4096) { return null; }
                object state = ShellWire.Serializer().DeserializeObject(File.ReadAllText(file));
                int found = ShellWire.Number(state, "pid");
                string reported = ShellWire.Text(state, "url");
                Uri address;
                IPAddress ip;

                if (ShellWire.Number(state, "version") != 1 || found <= 0 || expected > 0 && found != expected ||
                    !Uri.TryCreate(reported, UriKind.Absolute, out address) || !IPAddress.TryParse(address.DnsSafeHost, out ip) ||
                    !ShellListener.LocalAddress(ip) || (address.Scheme != "http" && address.Scheme != "https") ||
                    address.UserInfo.Length != 0 || address.PathAndQuery != "/" || address.Fragment.Length != 0) { return null; }
                using (Process process = Process.GetProcessById(found))
                {
                    if (process.HasExited || process.StartTime.ToUniversalTime() > record.LastWriteTimeUtc.AddSeconds(1) ||
                        !ShellListener.CurrentUser(process) || !process.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase)) { return null; }
                }
                string origin = address.GetLeftPart(UriPartial.Authority);
                object info = ShellWire.Serializer().DeserializeObject(Request("GET", origin + "/api/pocket/info", null));
                if (ShellWire.Text(info, "name") != "pi-pocket") { return null; }
                pid = found;
                verified = ShellListener.Owns(ip, address.Port, found);
                return origin;
            }
            catch (Exception) { return null; }
        }

        string LocalSignInAddress(string address)
        {
            LocalListener server = local;
            if (server != null && server.Address == address)
            {
                try
                {
                    object link = ShellWire.Serializer().DeserializeObject(VerifiedOwnerRequest(server, "/api/sign-in-link"));
                    string path = ShellWire.Text(link, "path");

                    if (path != null && Regex.IsMatch(path, @"\A/login\?once=[A-Za-z0-9_-]{16,128}\z")) { return address + path; }
                }
                catch (Exception) { }
            }
            Log("No one-time sign-in link.");
            return address + "/";
        }
    }

    static class ShellListener
    {
        [DllImport("iphlpapi.dll")]
        static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);
        [DllImport("ntdll.dll")]
        static extern int NtQueryInformationProcess(IntPtr handle, int informationClass, out ProcessBasic info, int length, out int written);

        [StructLayout(LayoutKind.Sequential)]
        struct ProcessBasic
        {
            public IntPtr reserved1, peb, reserved2, reserved3, pid, parent;
        }

        public static bool LocalAddress(IPAddress address)
        {
            if (IPAddress.IsLoopback(address)) { return true; }
            foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces())
            {
                foreach (UnicastIPAddressInformation entry in adapter.GetIPProperties().UnicastAddresses)
                {
                    if (address.Equals(entry.Address)) { return true; }
                }
            }
            return false;
        }

        public static bool CurrentUser(Process process)
        {
            IntPtr token;
            if (!OpenProcessToken(process.Handle, 8, out token)) { return false; }
            try
            {
                using (var other = new WindowsIdentity(token))
                using (var current = WindowsIdentity.GetCurrent()) { return current.User.Equals(other.User); }
            }
            finally { CloseHandle(token); }
        }

        static bool IsLauncher(int owner, int launcher)
        {
            if (owner == launcher) { return true; }
            try
            {
                using (Process child = Process.GetProcessById(owner))
                using (Process parent = Process.GetProcessById(launcher))
                {
                    ProcessBasic info;
                    int written;
                    return NtQueryInformationProcess(child.Handle, 0, out info, Marshal.SizeOf(typeof(ProcessBasic)), out written) == 0 &&
                        info.parent.ToInt64() == launcher && child.StartTime >= parent.StartTime && CurrentUser(child);
                }
            }
            catch (Exception) { return false; }
        }

        public static bool Owns(IPAddress address, int port, int launcher)
        {
            bool v6 = address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6;
            int family = v6 ? 23 : 2;
            int stride = v6 ? 56 : 24;
            int size = 0;
            GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 3, 0); // TCP_TABLE_OWNER_PID_LISTENER
            if (size < 4 || size > 1024 * 1024) { return false; }
            IntPtr table = Marshal.AllocHGlobal(size);
            try
            {
                if (GetExtendedTcpTable(table, ref size, false, family, 3, 0) != 0) { return false; }
                int count = Math.Min(Marshal.ReadInt32(table), (size - 4) / stride);
                int wildcard = 0;
                for (int index = 0; index < count; index++)
                {
                    IntPtr row = IntPtr.Add(table, 4 + index * stride);
                    int offset = v6 ? 20 : 8;
                    if (256 * Marshal.ReadByte(row, offset) + Marshal.ReadByte(row, offset + 1) != port) { continue; }
                    byte[] bytes = new byte[v6 ? 16 : 4];
                    Marshal.Copy(IntPtr.Add(row, v6 ? 0 : 4), bytes, 0, bytes.Length);
                    IPAddress bound = new IPAddress(bytes);
                    int owner = Marshal.ReadInt32(row, v6 ? 52 : 20);
                    if (address.Equals(bound)) { return IsLauncher(owner, launcher); }
                    if (bound.Equals(v6 ? IPAddress.IPv6Any : IPAddress.Any)) { wildcard = owner; }
                }
                return wildcard > 0 && IsLauncher(wildcard, launcher);
            }
            finally { Marshal.FreeHGlobal(table); }
        }
    }
}
