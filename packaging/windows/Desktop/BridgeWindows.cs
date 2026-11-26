using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace PiPocket
{
    static class BridgeProtocol
    {
        public static readonly string[] LegacyEvents = { "visibility", "open", "approve" };
        public static readonly string[] Events = { "visibility", "open", "approve", "newSession", "primary" };
        public static readonly string[] PinStates = { "waiting", "limited", "working", "failed", "fresh", "seen" };
        public static readonly EventWaitHandleSecurity IntentAccess = new EventWaitHandleSecurity();
        public static readonly string NewEventName;

        static BridgeProtocol()
        {
            using (WindowsIdentity user = WindowsIdentity.GetCurrent())
            {
                NewEventName = @"Local\Pi Pocket desktop: new:" + user.User.Value;
                IntentAccess.SetAccessRuleProtection(true, false);
                IntentAccess.AddAccessRule(new EventWaitHandleAccessRule(user.User,
                    EventWaitHandleRights.FullControl, AccessControlType.Allow));
            }
        }

        public static bool Recognises(Func<string, string> get)
        {
            var json = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 8 };
            try
            {
                var info = json.Deserialize<Dictionary<string, object>>(get("/api/pocket/info"));
                if (Text(info, "name", 32) != "pi-pocket") { return false; }
                object version;
                if (info.TryGetValue("bridge", out version) && version is int && (int)version >= 1) { return true; }
            }
            catch (Exception) { /* A server before v1 answers with 401 here. */ }
            try
            {
                var manifest = json.Deserialize<Dictionary<string, object>>(get("/manifest.webmanifest"));
                return Text(manifest, "name", 32) == "Pi Pocket";
            }
            catch (Exception) { return false; }
        }

        public static bool IsNewLink(string value)
        {
            // Windows can add a root slash to a protocol link. Accept that spelling, but do not normalize any other input.
            return string.Equals(value, "pi-pocket://new", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(value, "pi-pocket://new/", StringComparison.OrdinalIgnoreCase);
        }

        public static bool IsTarget(string path)
        {
            long id;
            return path == "/" || path == "/?pip=1" || (path != null && path.StartsWith("/s/", StringComparison.Ordinal) &&
                path.Length >= 4 && path.Length <= 19 && path[3] >= '1' && path[3] <= '9' &&
                path.Skip(3).All(c => c >= '0' && c <= '9') && long.TryParse(path.Substring(3), out id) &&
                id <= 9007199254740991L);
        }

        public static bool IsPage(string path) { return path == "/" || (path.StartsWith("/s/", StringComparison.Ordinal) && IsTarget(path)); }

        public static string Text(IDictionary<string, object> body, string name, int limit)
        {
            object value;
            string text = body.TryGetValue(name, out value) ? value as string : null;
            return text != null && text.Length <= limit ? text : null;
        }

        public static bool Flag(IDictionary<string, object> body, string name)
        {
            object value;
            return body.TryGetValue(name, out value) && value is bool && (bool)value;
        }
    }

    sealed class BridgePin
    {
        public readonly string Path, Title, State, Label;

        public BridgePin(string path, string title, string state, string label)
        {
            Path = path;
            Title = title;
            State = state;
            Label = label;
        }
    }

    // UI thread only. A connection can have many documents, but only one supplies the account's native feed.
    sealed class BridgeWindows : IDisposable
    {
        readonly TrayApp host;
        readonly List<BridgeView> views = new List<BridgeView>();
        readonly Timer timer = new Timer { Interval = 500 };
        BridgeView primary, newTarget;
        long newUntil;
        bool explained, closing;
        public IList<BridgePin> Pins { get; private set; }
        public readonly NoticesWindows Notices;

        public BridgeWindows(TrayApp host)
        {
            this.host = host;
            Pins = new List<BridgePin>().AsReadOnly();
            Notices = new NoticesWindows(Activate, host.Log, run => host.OnUi(() => run()));
            timer.Tick += delegate { FlushNew(); };
        }

        public void Add(BridgeView view) { views.Add(view); }

        public void Focus(BridgeView view)
        {
            if (views.Remove(view))
            {
                views.Insert(0, view);
                if (view.Subscribed) { Notices.Seen(); }
            }
        }

        public void Remove(BridgeView view)
        {
            views.Remove(view);
            Replaced(view);
        }

        public void Replaced(BridgeView view)
        {
            if (view == newTarget) { CancelNew(); }
            Reconcile();
        }

        public void Subscribed(BridgeView view)
        {
            if (view.Modern) { host.Log("A Pi Pocket page subscribed to the desktop bridge."); }
            Reconcile();
        }

        void Reconcile()
        {
            if (closing || (primary != null && primary.Subscribed && views.Contains(primary))) { return; }
            BridgeView next = views.FirstOrDefault(view => view.Subscribed);
            if (primary == next) { return; }

            if (primary != null) { primary.SetPrimary(false); }
            ClearFeed(false);
            primary = next;
            if (primary != null) { primary.SetPrimary(true); }
        }

        public void AccountChanged(BridgeView view, bool previouslyActive)
        {
            if (view == primary && previouslyActive) { ClearFeed(true); }
            if (view == newTarget && previouslyActive) { CancelNew(); }
            FlushNew();
        }

        internal bool IsPrimary(BridgeView view) { return !closing && primary == view; }

        public void Badge(BridgeView view, int count)
        {
            if (IsPrimary(view)) { host.SetBadge(count); }
        }

        public void Pinned(BridgeView view, IList<BridgePin> pins)
        {
            if (IsPrimary(view)) { Pins = pins; }
        }

        public void Notice(BridgeView view, NoticeData notice)
        {
            if (IsPrimary(view) && host.NotificationsEnabled) { Notices.Receive(notice, view.Lease, view.Auth, view.Modern); }
        }

        void ClearFeed(bool forget)
        {
            Pins = new List<BridgePin>().AsReadOnly();
            host.SetBadge(0);
            Notices.Clear(forget);
        }

        public void ResetConnection(bool keepUnboundNewSession = false)
        {
            closing = true;
            // The first connection may arrive after a cold-launch URL. Never keep an intent bound to an old view.
            if (!keepUnboundNewSession || newTarget != null) { CancelNew(); }
            if (primary != null) { primary.SetPrimary(false); }
            primary = null;
            views.Clear();
            ClearFeed(true);
            explained = false;
            closing = false;
        }

        public void OpenPin(string path)
        {
            if (primary != null && Pins.Any(pin => pin.Path == path))
            {
                primary.Raise();
                primary.Deliver("open", path, null, false);
            }
        }

        void Activate(NoticeTicket ticket, string choice)
        {
            if (ticket != null && primary != null && ticket.Matches(primary.Lease, primary.Auth, choice, DateTime.UtcNow))
            {
                BridgeView view = primary;
                if (choice == "open" && view.Deliver("open", ticket.Path, null, false)) { view.Raise(); return; }
                if (choice != "open" && view.Deliver("approve", null, ticket.Approval, choice == "allow")) { view.Raise(); return; }
            }

            // A click from a prior process, connection, account or document can only bring up the current page.
            host.OpenWindow();
        }

        static long Millis() { return Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency; }

        public void NewSession()
        {
            if (closing) { return; }
            newUntil = Millis() + 12000;
            newTarget = views.FirstOrDefault(view => view.Subscribed) ?? views.FirstOrDefault();
            if (newTarget != null) { newTarget.Raise(); } else { host.OpenWindow(); }
            timer.Start();
            FlushNew();
        }

        public void FlushNew()
        {
            if (newUntil == 0 || closing) { return; }
            if (newTarget == null) { newTarget = views.FirstOrDefault(view => view.Subscribed); }
            BridgeView target = newTarget;
            if (target != null && target.Deliver("newSession", null, null, false))
            {
                host.Log("Delivered New Session to the Pi Pocket page.");
                CancelNew();
                return;
            }
            if (target != null && target.Subscribed && target.Modern && target.AccountKnown && !target.Active)
            {
                CancelNew();
                return;
            }
            if ((target != null && target.Subscribed && !target.Can("newSession")) ||
                Millis() >= newUntil)
            {
                CancelNew();
                if (!explained && views.Count > 0)
                {
                    explained = true;
                    host.BridgeTip("If New session is available to you, open it with New in the Pi Pocket page.");
                }
            }
        }

        void CancelNew()
        {
            newUntil = 0;
            newTarget = null;
            timer.Stop();
        }

        public void Dispose()
        {
            ResetConnection();
            timer.Dispose();
            Notices.Dispose();
        }
    }
}
