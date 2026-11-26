using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;
using System.Xml.Linq;
using Microsoft.Win32;
using Windows.UI.Notifications;

namespace PiPocket
{
    sealed class NoticesWindows : IDisposable
    {
        public const string AppId = "PiPocket.Desktop";

        public static void SetAppIdentity() { SetCurrentProcessExplicitAppUserModelID(AppId); }
        const string Group = "PiPocket";
        const string Finishes = "finishes";
        readonly Action<NoticeTicket, string> activate;
        readonly Action<string> log;
        readonly Action<Action> ui;
        readonly Dictionary<string, NoticeTicket> tickets = new Dictionary<string, NoticeTicket>();
        readonly Dictionary<string, DateTime> seen = new Dictionary<string, DateTime>();
        readonly List<NoticeData> finishes = new List<NoticeData>();
        readonly Timer timer = new Timer { Interval = 5000 };
        readonly ToastClassFactory factory;
        int registration;
        bool suspended, locked, held, disposed;
        string latestLease;
        int latestAuth;
        public bool Enabled = true;
        public bool Sound = true;
        public string AllowMode = "whenFullyShown";
        public int CommandLimit = 120;
        public string Unavailable { get; private set; }

        public NoticesWindows(Action<NoticeTicket, string> activate, Action<string> log, Action<Action> ui)
        {
            this.activate = activate;
            this.log = log;
            this.ui = ui;
            factory = new ToastClassFactory(arguments => ui(() => Activated(arguments)));
            Guid clsid = new Guid("3482e279-4bab-4932-bf9d-ce95126fe324");
            int error = CoRegisterClassObject(ref clsid, factory, 4, 1, out registration);
            if (error < 0) { Unavailable = "Windows could not register Pi Pocket notification activation."; }
            timer.Tick += delegate { Recheck(); };
            SystemEvents.SessionSwitch += SessionChanged;
            SystemEvents.PowerModeChanged += PowerChanged;
        }

        void SessionChanged(object sender, SessionSwitchEventArgs args)
        {
            ui(delegate
            {
                if (args.Reason == SessionSwitchReason.SessionLock || args.Reason == SessionSwitchReason.SessionLogoff ||
                    args.Reason == SessionSwitchReason.ConsoleDisconnect || args.Reason == SessionSwitchReason.RemoteDisconnect) { locked = true; }
                if (args.Reason == SessionSwitchReason.SessionUnlock || args.Reason == SessionSwitchReason.SessionLogon ||
                    args.Reason == SessionSwitchReason.ConsoleConnect || args.Reason == SessionSwitchReason.RemoteConnect) { locked = false; Recheck(); }
            });
        }

        void PowerChanged(object sender, PowerModeChangedEventArgs args)
        {
            ui(delegate
            {
                if (args.Mode == PowerModes.Suspend) { suspended = true; }
                if (args.Mode == PowerModes.Resume) { suspended = false; Recheck(); }
            });
        }

        bool Away()
        {
            var last = new LastInputInfo { Size = (uint)Marshal.SizeOf(typeof(LastInputInfo)) };
            return suspended || locked || (GetLastInputInfo(ref last) && unchecked((uint)Environment.TickCount - last.Time) >= 120000U);
        }

        public void Receive(NoticeData data, string lease, int auth, bool modern)
        {
            if (!Enabled || disposed) { return; }
            Prune();
            string fingerprint = Slot(data.Tag + "\n" + data.Stamp + "\n" + data.Path + "\n" + data.Title + "\n" + data.Body + "\n" + data.Call);
            if (seen.ContainsKey(fingerprint)) { return; }
            if (seen.Count >= 256) { seen.Remove(seen.OrderBy(pair => pair.Value).First().Key); }
            seen[fingerprint] = DateTime.UtcNow.AddMinutes(10);

            if (!data.Finish)
            {
                Show(data, Slot("notice:" + data.Tag), lease, auth, modern);
                return;
            }

            finishes.RemoveAll(each => each.Tag == data.Tag);
            if (finishes.Count >= 100) { finishes.RemoveAt(0); }
            finishes.Add(data);
            latestLease = lease;
            latestAuth = auth;
            if (Away()) { held = true; timer.Start(); }
            else { ShowFinishes(); }
        }

        public void Local(string body)
        {
            Show(new NoticeData { Title = "Pi Pocket", Body = body, Path = "/" }, "local", null, 0, false);
        }

        void Recheck()
        {
            if (!disposed && held && !Away()) { ShowFinishes(); }
        }

        void ShowFinishes()
        {
            held = false;
            timer.Stop();
            var data = NoticeData.Group(finishes);
            if (data != null) { Show(data, Finishes, latestLease, latestAuth, false); }
        }

        void Show(NoticeData data, string slot, string lease, int auth, bool modern)
        {
            if (registration == 0 || !Enabled) { return; }
            try
            {
                var notifier = ToastNotificationManager.CreateToastNotifier(AppId);
                if (notifier.Setting != NotificationSetting.Enabled)
                {
                    SetUnavailable("Windows notifications are unavailable: " + notifier.Setting + ".");
                    return;
                }
                SetUnavailable(null);
                string body = data.Body;
                bool allow = data.Approval != null && data.CanAllow(AllowMode, CommandLimit, out body);
                string approval = modern ? data.Approval : null;
                var ticket = new NoticeTicket {
                    Token = Guid.NewGuid().ToString("N"), Lease = lease, Auth = auth, Path = data.Path, Slot = slot,
                    Approval = approval, Allow = approval != null && allow, Expires = DateTime.UtcNow.AddMinutes(10),
                };
                var toast = new XElement("toast", new XAttribute("launch", "open:" + ticket.Token),
                    new XElement("visual", new XElement("binding", new XAttribute("template", "ToastGeneric"),
                        new XElement("text", string.IsNullOrEmpty(data.Title) ? "Pi Pocket" : data.Title), new XElement("text", body))));
                if (approval != null)
                {
                    var buttons = new XElement("actions");
                    if (ticket.Allow) { buttons.Add(Button("Allow", "allow:", ticket.Token)); }
                    buttons.Add(Button("Deny", "deny:", ticket.Token));
                    toast.Add(buttons);
                }
                if (!Sound) { toast.Add(new XElement("audio", new XAttribute("silent", "true"))); }
                var xml = new Windows.Data.Xml.Dom.XmlDocument();
                xml.LoadXml(toast.ToString(SaveOptions.DisableFormatting));
                var notification = new ToastNotification(xml) { Tag = slot, Group = Group, ExpirationTime = ticket.Expires };
                if (slot == Finishes)
                {
                    var included = new HashSet<NoticeData>(finishes);
                    notification.Dismissed += delegate(ToastNotification sender, ToastDismissedEventArgs args)
                    {
                        if (args.Reason == ToastDismissalReason.UserCanceled) { ui(() => DismissFinishes(ticket, included)); }
                    };
                }
                if (tickets.Count >= 128) { Remove(tickets.OrderBy(pair => pair.Value.Expires).First().Key); }
                tickets[slot] = ticket;
                notifier.Show(notification);
            }
            catch (Exception error)
            {
                SetUnavailable("Windows could not show a Pi Pocket notification (" + error.GetType().Name + ").");
            }
        }

        void SetUnavailable(string reason)
        {
            if (Unavailable == reason) { return; }
            Unavailable = reason;
            log(reason ?? "Windows notifications are available.");
        }

        static XElement Button(string label, string verb, string token)
        {
            return new XElement("action", new XAttribute("content", label), new XAttribute("arguments", verb + token),
                new XAttribute("activationType", "foreground"));
        }

        static string Slot(string text)
        {
            using (var sha = SHA256.Create())
            {
                return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text)), 0, 8).Replace("-", "");
            }
        }

        void DismissFinishes(NoticeTicket ticket, HashSet<NoticeData> included)
        {
            NoticeTicket current;
            if (tickets.TryGetValue(Finishes, out current) && current == ticket)
            {
                tickets.Remove(Finishes);
                finishes.RemoveAll(included.Contains);
            }
        }

        void Activated(string arguments)
        {
            if (disposed || !Enabled || arguments == null || arguments.Length > 40) { return; }
            var parts = arguments.Split(':');
            if (parts.Length != 2 || (parts[0] != "open" && parts[0] != "allow" && parts[0] != "deny") || parts[1].Length != 32) { return; }
            Prune();
            NoticeTicket ticket = tickets.Values.FirstOrDefault(each => each.Token == parts[1]);
            if (ticket != null)
            {
                if (ticket.Slot == Finishes) { Seen(); } else { Remove(ticket.Slot); }
            }
            activate(ticket, parts[0]);
        }

        public void Seen()
        {
            finishes.Clear();
            Remove(Finishes);
            timer.Stop();
            held = false;
        }

        void Remove(string slot)
        {
            if (tickets.Remove(slot))
            {
                try { ToastNotificationManager.History.Remove(slot, Group, AppId); }
                catch (Exception) { /* Windows can remove notifications independently. */ }
            }
        }

        void Prune()
        {
            var now = DateTime.UtcNow;
            foreach (string slot in tickets.Where(pair => pair.Value.Expires <= now).Select(pair => pair.Key).ToArray()) { Remove(slot); }
            foreach (string key in seen.Where(pair => pair.Value <= now).Select(pair => pair.Key).ToArray()) { seen.Remove(key); }
        }

        public void Clear(bool forget)
        {
            Seen();
            latestLease = null;
            foreach (string slot in tickets.Keys.ToArray()) { Remove(slot); }
            if (forget) { seen.Clear(); }
        }

        public void Dispose()
        {
            disposed = true;
            Clear(true);
            timer.Dispose();
            SystemEvents.SessionSwitch -= SessionChanged;
            SystemEvents.PowerModeChanged -= PowerChanged;
            if (registration != 0) { CoRevokeClassObject(registration); }
            GC.KeepAlive(factory);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

        [StructLayout(LayoutKind.Sequential)]
        struct LastInputInfo { public uint Size, Time; }
        [DllImport("user32.dll")]
        static extern bool GetLastInputInfo(ref LastInputInfo info);
        [DllImport("ole32.dll")]
        static extern int CoRegisterClassObject(ref Guid classId, [MarshalAs(UnmanagedType.Interface)] IToastClassFactory factory,
            uint context, uint flags, out int cookie);
        [DllImport("ole32.dll")]
        static extern int CoRevokeClassObject(int cookie);
    }

    // Shell starts this local server through the current-user CLSID registered by Setup. No notice data is in its command line.
    [ComVisible(true), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("00000001-0000-0000-C000-000000000046")]
    public interface IToastClassFactory
    {
        [PreserveSig] int CreateInstance(IntPtr outer, ref Guid iid, out IntPtr result);
        [PreserveSig] int LockServer([MarshalAs(UnmanagedType.Bool)] bool locked);
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class ToastClassFactory : IToastClassFactory
    {
        readonly Action<string> activate;
        internal ToastClassFactory(Action<string> activate) { this.activate = activate; }
        public int CreateInstance(IntPtr outer, ref Guid iid, out IntPtr result)
        {
            result = IntPtr.Zero;
            if (outer != IntPtr.Zero) { return unchecked((int)0x80040110); }
            IntPtr unknown = Marshal.GetIUnknownForObject(new ToastActivator(activate));
            try { return Marshal.QueryInterface(unknown, ref iid, out result); }
            finally { Marshal.Release(unknown); }
        }
        public int LockServer(bool locked) { return 0; }
    }

    [ComVisible(true), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("53E31837-6600-4A81-9395-75CFFE746F94")]
    public interface IToastActivationCallback
    {
        void Activate([MarshalAs(UnmanagedType.LPWStr)] string appId, [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            IntPtr inputs, uint count);
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class ToastActivator : IToastActivationCallback
    {
        readonly Action<string> activate;
        internal ToastActivator(Action<string> activate) { this.activate = activate; }
        public void Activate(string appId, string arguments, IntPtr inputs, uint count)
        {
            if (appId == NoticesWindows.AppId && count == 0) { activate(arguments); }
        }
    }
}
