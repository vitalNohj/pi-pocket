using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PiPocket
{
    // This executable is built only on the Windows test runner. It is not in Setup.
    static class BridgeWindowsTests
    {
        static void Check(bool value, string description)
        {
            if (!value) { throw new InvalidOperationException(description); }
        }

        [STAThread]
        static int Main()
        {
            Check(BridgeProtocol.IsNewLink("pi-pocket://new"), "New Session URL");
            foreach (var url in new[] { "pi-pocket://new/", "pi-pocket://new:80", "pi-pocket://new?", "pi-pocket://name@new", "pi-pocket://new#x" })
            {
                Check(!BridgeProtocol.IsNewLink(url), "Reject noncanonical New Session URL: " + url);
            }
            foreach (var url in new[] { "/s/", "/s/0", "/s/01", "/s/9007199254740992", "//example.invalid", "/s/2?", "/?pip=1&more=1" })
            {
                Check(!BridgeProtocol.IsTarget(url), "Reject noncanonical notice URL: " + url);
            }
            Check(BridgeProtocol.IsTarget("/s/9007199254740991") && BridgeProtocol.IsTarget("/?pip=1"), "Accept session and PiP");
            Check(BridgeProtocol.Recognises(path => path == "/api/pocket/info"
                ? "{\"name\":\"pi-pocket\",\"bridge\":1}" : "{}"), "Recognize bridge v1");
            Check(BridgeProtocol.Recognises(path => {
                if (path != "/manifest.webmanifest") { throw new IOException("The older server answers 401."); }
                return "{\"name\":\"Pi Pocket\"}";
            }), "Recognize legacy manifest");
            Check(!BridgeProtocol.Recognises(_ => "{\"name\":\"unrelated\",\"bridge\":1}"), "Reject unrelated server");

            var json = new JavaScriptSerializer();
            var first = NoticeData.Read(json.Deserialize<Dictionary<string, object>>(
                "{\"tag\":\"done-8\",\"url\":\"/s/8\",\"title\":\"Pi finished · Build\"}"));
            var second = NoticeData.Read(json.Deserialize<Dictionary<string, object>>(
                "{\"tag\":\"done-9\",\"url\":\"/s/9\",\"title\":\"Pi finished · Tests\"}"));
            var group = NoticeData.Group(new[] { first, second });
            Check(first.Finish && group.Title == "2 sessions finished" && group.Body == "Tests\nBuild" && group.Path == "/s/9", "Group finishes by latest");
            var approval = NoticeData.Read(json.Deserialize<Dictionary<string, object>>(
                "{\"tag\":\"approval-test\",\"url\":\"/s/8\",\"approval\":{\"id\":\"test\",\"call\":\"read: notes\",\"may\":true}}"));
            string shown;
            Check(approval.CanAllow("whenFullyShown", 120, out shown) && shown == "read: notes", "A small full call may be allowed");
            approval.Call = "read:\u202Enotes";
            Check(!approval.CanAllow("whenFullyShown", 120, out shown) && shown.Contains("[U+202E]"), "Mark hidden text; omit Allow");
            approval.Call = new string('a', 100);
            Check(!approval.CanAllow("whenFullyShown", 20, out shown) && shown.Contains("[shortened]"), "Mark truncation; omit Allow");
            approval.May = false;
            Check(!approval.CanAllow("always", 20, out shown), "The local setting cannot override server eligibility");

            var now = DateTime.UtcNow;
            var ticket = new NoticeTicket { Lease = "document", Auth = 7, Approval = "test", Expires = now.AddSeconds(1) };
            Check(ticket.Matches("document", 7, "deny", now), "Current Deny");
            Check(!ticket.Matches("document", 7, "allow", now), "Allow was not offered");
            Check(!ticket.Matches("second", 7, "deny", now) && !ticket.Matches("document", 8, "deny", now) &&
                !ticket.Matches("document", 7, "deny", now.AddSeconds(2)), "Document, auth epoch and expiry invalidate actions");

            CheckFrame();
            Console.WriteLine("Windows bridge message, frame and notice tests passed.");
            return 0;
        }

        static void CheckFrame()
        {
            const string origin = "https://pocket-fixture.invalid";
            const string top = @"<!doctype html><script>
                addEventListener('message', (e) => chrome.webview.postMessage(e.data));
                pocketHost.subscribe(() => {});
            </script><iframe sandbox='allow-scripts' src='/s/2'></iframe>";
            const string frame = @"<!doctype html><script>
                parent.postMessage({ absent: !('pocketHost' in window), opaque: window.origin === 'null' }, '*');
            </script>";
            Exception failure = null;
            bool reported = false;
            using (var form = new Form { Width = 680, Height = 460 })
            using (var view = new WebView2 { Dock = DockStyle.Fill })
            using (var timer = new Timer { Interval = 30000 })
            {
                form.Controls.Add(view);
                timer.Tick += delegate { form.Close(); };
                form.Shown += async delegate
                {
                    try
                    {
                        string profile = Path.Combine(Path.GetTempPath(), "pocket-bridge-test-" + Guid.NewGuid().ToString("N"));
                        var environment = await CoreWebView2Environment.CreateAsync(null, profile);
                        await view.EnsureCoreWebView2Async(environment);
                        var core = view.CoreWebView2;
                        core.AddWebResourceRequestedFilter(origin + "/*", CoreWebView2WebResourceContext.Document,
                            CoreWebView2WebResourceRequestSourceKinds.Document);
                        core.WebResourceRequested += delegate (object sender, CoreWebView2WebResourceRequestedEventArgs args)
                        {
                            string html = new Uri(args.Request.Uri).AbsolutePath == "/" ? top : frame;
                            args.Response = environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(html)),
                                200, "OK", "Content-Type: text/html; charset=utf-8");
                        };
                        core.WebMessageReceived += delegate (object sender, CoreWebView2WebMessageReceivedEventArgs args)
                        {
                            var message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(args.WebMessageAsJson);
                            reported = args.Source == origin + "/" && BridgeProtocol.Flag(message, "absent") &&
                                BridgeProtocol.Flag(message, "opaque");
                            form.BeginInvoke((MethodInvoker)form.Close);
                        };
                        await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeView.Script(origin));
                        core.Navigate(origin + "/");
                    }
                    catch (Exception error) { failure = error; form.Close(); }
                };
                timer.Start();
                Application.Run(form);
            }
            if (failure != null) { throw failure; }
            Check(reported, "Top document has the bridge; sandboxed same-origin session frame has none.");
        }
    }
}
