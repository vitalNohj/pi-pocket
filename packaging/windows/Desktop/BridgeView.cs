using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

namespace PiPocket
{
    sealed class BridgeView
    {
        static readonly string Bootstrap = ReadBootstrap();
        readonly BridgeWindows windows;
        readonly PocketWindow window;
        readonly CoreWebView2 browser;
        readonly string origin, basePath;
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 10 };
        HashSet<string> events;
        readonly HashSet<string> actions = new HashSet<string> { "new-session", "new-window", "server-settings" };
        readonly Action<string> action;
        readonly Action<object> dictation;
        ulong navigation;
        bool? shown;
        public string Lease { get; private set; }
        public int Auth { get; private set; }
        public bool Active { get; private set; }
        public bool AccountKnown { get { return Auth > 0; } }
        public bool Subscribed { get { return events != null; } }
        public bool Modern { get { return Can("primary"); } }

        public BridgeView(BridgeWindows windows, PocketWindow window, CoreWebView2 browser, string origin, string basePath,
            Action<string> action, Action<object> dictation = null)
        {
            this.window = window;
            this.windows = windows;
            this.browser = browser;
            this.origin = origin;
            this.basePath = basePath;
            this.action = action;
            this.dictation = dictation;
        }

        static string ReadBootstrap()
        {
            using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("PocketBridge.js"))
            using (StreamReader reader = new StreamReader(input)) { return reader.ReadToEnd(); }
        }

        public Task Attach(string speechScript = "null")
        {
            windows.Add(this);
            window.Activated += delegate { windows.Focus(this); };
            window.Disposed += delegate { Reset(); windows.Remove(this); };
            browser.WebMessageReceived += Receive;
            browser.DOMContentLoaded += delegate (object sender, CoreWebView2DOMContentLoadedEventArgs args)
            {
                if (args.NavigationId == navigation && PocketWindow.IsServerAddress(browser.Source, origin) &&
                    BridgeProtocol.IsPage(new Uri(browser.Source).AbsolutePath, basePath))
                {
                    Lease = Guid.NewGuid().ToString("N");
                    Push(new { type = "bind", key = Lease, visible = window.ShownToUser });
                }
            };
            browser.NavigationCompleted += delegate (object sender, CoreWebView2NavigationCompletedEventArgs args)
            {
                if (args.NavigationId == navigation && !args.IsSuccess) { Reset(); windows.Replaced(this); }
            };
            browser.ProcessFailed += delegate (object sender, CoreWebView2ProcessFailedEventArgs args)
            {
                if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited ||
                    args.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
                {
                    Reset();
                    windows.Replaced(this);
                }
            };
            return browser.AddScriptToExecuteOnDocumentCreatedAsync(Script(origin, basePath, speechScript));
        }

        internal static string Script(string origin, string basePath, string speechScript = "null")
        {
            var config = new
            {
                origin = origin, basePath = basePath, kind = "pi-pocket-windows", items = new[] {
                    new { id = "new-session", label = "New session" }, new { id = "new-window", label = "New window" },
                    new { id = "server-settings", label = "Desktop Settings…" },
                },
            };
            return Bootstrap.Replace("/* POCKET_BRIDGE_ARGUMENTS */", new JavaScriptSerializer().Serialize(config) + @", {
                send: (message) => window.chrome.webview.postMessage(message),
                listen: (receive) => window.chrome.webview.addEventListener('message', (event) => receive(event.data)),
            }, " + speechScript);
        }

        public void Navigating(ulong id)
        {
            navigation = id;
            bool replaced = Lease != null;
            Reset();
            if (replaced) { windows.Replaced(this); }
        }

        void Reset()
        {
            Lease = null;
            events = null;
            Auth = 0;
            Active = false;
            shown = null;
        }

        void Receive(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            // Only CoreWebView2 (not CoreWebView2Frame) messages are registered. A URL is not an effective origin;
            // the lease is accepted only by the bootstrap after its extra effective-origin check at document start.
            if (Lease == null || !PocketWindow.IsServerAddress(args.Source, origin) ||
                !PocketWindow.IsServerAddress(browser.Source, origin)) { return; }
            Dictionary<string, object> body;
            try { body = json.Deserialize<Dictionary<string, object>>(args.WebMessageAsJson); }
            catch (ArgumentException) { return; }
            catch (InvalidOperationException) { return; }
            if (body == null || BridgeProtocol.Text(body, "key", 32) != Lease) { return; }
            string type = BridgeProtocol.Text(body, "type", 12);
            if (type == "dictation") { if (dictation != null) { dictation(body); } return; }
            object value;

            if (type == "subscribe" && !Subscribed)
            {
                string[] supported = body.TryGetValue("events", out value) && value is IList
                    ? ((IList)value).Cast<object>().OfType<string>().Take(8).ToArray() : BridgeProtocol.LegacyEvents;
                events = new HashSet<string>(BridgeProtocol.Events.Intersect(supported));
                windows.Subscribed(this);
                Visibility();
                windows.FlushNew();
                return;
            }

            if (!Subscribed || !body.TryGetValue("auth", out value) || !(value is int)) { return; }
            int auth = (int)value;
            if (type == "account" && Modern && auth > Auth)
            {
                bool wasActive = Active;
                Auth = auth;
                Active = BridgeProtocol.Flag(body, "active");
                windows.AccountChanged(this, wasActive);
                return;
            }

            if (type == "action")
            {
                string id = BridgeProtocol.Text(body, "id", 30);
                if (id != null && actions.Contains(id)) { action(id); }
                return;
            }

            if (auth != Auth || (Modern && !Active) || !windows.IsPrimary(this)) { return; }

            if (type == "badge" && body.TryGetValue("count", out value) && value is int && (int)value >= 0)
            {
                windows.Badge(this, (int)value);
            }
            else if (type == "pinned" && body.TryGetValue("pins", out value) && value is IList)
            {
                var pins = new List<BridgePin>();
                foreach (var item in ((IList)value).Cast<object>().OfType<Dictionary<string, object>>().Take(20))
                {
                    object id;
                    if (!item.TryGetValue("id", out id) || (!(id is int) && !(id is long))) { continue; }
                    string path = "/s/" + Convert.ToString(id, CultureInfo.InvariantCulture);
                    string state = BridgeProtocol.Text(item, "state", 12);
                    if (!BridgeProtocol.IsTarget(path) || !BridgeProtocol.PinStates.Contains(state)) { continue; }
                    pins.Add(new BridgePin(path, NoticeData.Plain(BridgeProtocol.Text(item, "title", 240), 70),
                        state, NoticeData.Plain(BridgeProtocol.Text(item, "label", 120), 60)));
                }
                windows.Pinned(this, pins.AsReadOnly());
            }
            else if (type == "notify" && body.TryGetValue("notice", out value))
            {
                var notice = NoticeData.Read(value as IDictionary<string, object>);
                if (notice != null) { windows.Notice(this, notice); }
            }
        }

        bool Push(object packet)
        {
            if (Lease == null || window.IsDisposed || window.Disposing) { return false; }
            try
            {
                if (!PocketWindow.IsServerAddress(browser.Source, origin)) { return false; }
                browser.PostWebMessageAsJson(json.Serialize(packet));
                return true;
            }
            catch (InvalidOperationException) { return false; }
            catch (System.Runtime.InteropServices.COMException) { return false; }
        }

        internal bool SendDictation(string op, string scope, string id, object parts, string message)
        {
            return Push(new { type = "dictation", key = Lease, op = op, scope = scope, id = id, parts = parts, message = message });
        }

        public bool Can(string name) { return events != null && events.Contains(name); }
        public bool Deliver(string type, string path, string id, bool allow)
        {
            return Can(type) && (!Modern || Active) && (type != "approve" || Modern) &&
                Push(new { type = type, key = Lease, auth = Auth, url = path, id = id, allow = allow });
        }
        public void SetPrimary(bool value) { Push(new { type = "primary", key = Lease, primary = value }); }
        public void Raise() { window.ShowWindow(); }
        public void Visibility()
        {
            bool visible = window.ShownToUser;
            if (shown != visible && Can("visibility") && Push(new { type = "visibility", key = Lease, visible = visible }))
            {
                shown = visible;
            }
        }
    }
}
