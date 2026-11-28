using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PiPocket
{
    sealed partial class TrayApp
    {
        DictationKey dictationKey;
        PocketWindow lastDictationView;
        readonly HashSet<string> speechConsent = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        internal string DictationScript { get { return Path.Combine(appDir, @"desktop-assets\protocol\page-dictation.js"); } }

        void StartDictationKey()
        {
            dictationKey = new DictationKey(() => Form.ActiveForm as PocketWindow, () =>
            {
                object prefs = ShellWire.Get(ShellWire.Get(snapshot, "preferences"), "dictation");
                return new[] { ShellWire.Text(prefs, "key"), ShellWire.Text(prefs, "keyMode") };
            });
        }

        internal void RememberDictationView(PocketWindow page) { lastDictationView = page; }

        internal string DictationFixture(string origin)
        {
            // The integration test uses an isolated local app profile and substitutes only the PCM source.
            return !String.IsNullOrEmpty(Environment.GetEnvironmentVariable("PI_POCKET_DESKTOP_STATE")) && new Uri(origin).IsLoopback
                ? Environment.GetEnvironmentVariable("PI_POCKET_DICTATION_SMOKE_PCM") : null;
        }

        internal bool AllowDictation(PocketWindow view, string origin)
        {
            if (DictationFixture(origin) != null || speechConsent.Contains(origin)) { return true; }
            if (MessageBox.Show(view, "Allow the microphone for offline dictation on this server?\n\n" + origin +
                "\n\nPi Pocket recognizes speech on this device. It does not send audio to the server.",
                "Pi Pocket Dictation", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
            {
                return false;
            }
            speechConsent.Add(origin);
            return true;
        }

        internal Task<object> DictationReport(string op, object data)
        {
            if (controller == null || quitting) { throw new InvalidOperationException("The desktop controller is not available."); }
            return controller.Call("host.report", new { @event = "dictation." + op, data = data });
        }

        async Task<object> DictationOperation(string op, object data)
        {
            PocketWindow target = Form.ActiveForm as PocketWindow ?? lastDictationView ?? window;

            if (op == "toggle")
            {
                if (target == null || target.IsDisposed || !target.Visible || !target.HasDictation)
                {
                    throw new InvalidOperationException("Focus an editable Pi Pocket composer first.");
                }
                target.ShowWindow();
                if (!target.SendDictationKey("toggle")) { throw new InvalidOperationException("Focus an editable Pi Pocket composer first."); }
            }
            else if (op == "copy")
            {
                target = FindDictationView(data);
                string text = ShellWire.Text(data, "text");
                if (target == null || String.IsNullOrEmpty(text) || text.Length > 6000)
                {
                    throw new InvalidOperationException("There is no dictation to copy for this server.");
                }
                Clipboard.SetText(text, TextDataFormat.UnicodeText);
            }
            else
            {
                target = FindDictationView(data);
                if (target != null) { await target.DictationResult(data); }
            }
            return null;
        }

        PocketWindow FindDictationView(object data)
        {
            if (window != null && window.HasDictationScope(data)) { return window; }
            foreach (PocketWindow extra in popups)
            {
                if (extra.HasDictationScope(data)) { return extra; }
            }
            return null;
        }

        internal void ShowDictationFixtureMenu(PocketWindow owner)
        {
            trayMenu.Show(owner, owner.PointToClient(Cursor.Position));
        }

        void StopDictation()
        {
            if (dictationKey != null) { dictationKey.Dispose(); dictationKey = null; }
            if (window != null) { window.DetachDictation(); }
            foreach (PocketWindow extra in popups.ToArray()) { extra.DetachDictation(); }
            lastDictationView = null;
            speechConsent.Clear();
        }
    }

    sealed partial class PocketWindow
    {
        string dictationScope;
        DictationSession speech;
        Label dictationIndicator;
        bool askingForMic;

        bool DictationOrigin { get { return new Uri(origin).Scheme == "https" || new Uri(origin).IsLoopback; } }
        bool DictationPage
        {
            get { return DictationOrigin && bridge != null && bridge.Lease != null && committed && !IsDisposed && !Disposing && generation == host.PageGeneration &&
                Browser != null && IsServerAddress(Browser.Source, origin); }
        }
        bool DictationFocus { get { return DictationPage && ShownToUser && Form.ActiveForm == this; } }
        internal bool HasDictation { get { return DictationPage && dictationScope != null; } }

        sealed class DictationSession
        {
            public string Scope, Id;
            public CancellationTokenSource End = new CancellationTokenSource();
            public Task Capture;
            public bool Stopping;
            public volatile bool Discard;
        }

        internal bool HasDictationScope(object data)
        {
            return HasDictation && generation == ShellWire.Number(data, "generation") && dictationScope == ShellWire.Text(data, "scope");
        }

        string InstallDictation()
        {
            if (!DictationOrigin || !File.Exists(host.DictationScript)) { return "null"; }
            Deactivate += delegate { if (!askingForMic) { CancelDictation(); } };
            Activated += delegate { if (HasDictation) { host.RememberDictationView(this); } };
            VisibleChanged += delegate { if (!ShownToUser) { CancelDictation(); } };
            Resize += delegate { if (!ShownToUser) { CancelDictation(); } };
            Disposed += delegate { DetachDictation(); };
            return File.ReadAllText(host.DictationScript).Trim().TrimEnd(';');
        }

        static bool SpeechId(string value)
        {
            if (value == null || value.Length != 32) { return false; }
            foreach (char item in value)
            {
                if (!(item >= '0' && item <= '9') && !(item >= 'a' && item <= 'f')) { return false; }
            }
            return true;
        }

        Task<object> ReportSpeech(string op, string scope, string id = null, byte[] frame = null)
        {
            var data = new Dictionary<string, object> { { "generation", generation }, { "scope", scope } };
            if (id != null) { data["id"] = id; }
            if (frame != null) { data["pcm"] = Convert.ToBase64String(frame); }
            return host.DictationReport(op, data);
        }

        async void ReceiveDictation(object message)
        {
            if (!DictationPage) { return; }
            string op = ShellWire.Text(message, "op");
            string scope = ShellWire.Text(message, "scope");
            string id = ShellWire.Text(message, "id");

            try
            {
                if (op == "settings" && DictationFocus) { host.OpenSettings("dictation"); return; }
                if (!SpeechId(scope)) { return; }
                if (op == "attach" && dictationScope != scope)
                {
                    DetachDictation();
                    dictationScope = scope;
                    if (DictationFocus) { host.RememberDictationView(this); }
                    await ReportSpeech("attach", scope);
                }
                else if (scope == dictationScope)
                {
                    if (op == "detach") { DetachDictation(); }
                    else if (op == "start" && SpeechId(id) && speech == null) { await StartDictation(scope, id); }
                    else if (speech != null && speech.Id == id)
                    {
                        if (op == "stop") { await FinishDictation(speech); }
                        else if (op == "cancel") { CancelDictation(false); }
                    }
                }
            }
            catch (Exception) { CancelDictation(); }
        }

        async Task StartDictation(string scope, string id)
        {
            if (!DictationFocus)
            {
                SendSpeech("error", scope, id, message: "Focus an editable Pi Pocket composer first.");
                return;
            }
            var session = new DictationSession { Scope = scope, Id = id };
            speech = session;

            try
            {
                askingForMic = true;
                bool consent;
                try { consent = host.AllowDictation(this, origin); }
                finally { askingForMic = false; }
                if (speech != session || !DictationFocus) { CancelDictation(); return; }
                if (!consent) { throw new InvalidOperationException("Microphone access was not allowed for this server."); }
                await ReportSpeech("start", scope, id);
                if (speech != session) { return; }
                if (!DictationFocus) { CancelDictation(); return; }
                if (session.Stopping) { await FinishDictation(session, true); return; }

                ShowDictationIndicator(true);
                session.Capture = DictationCapture.Run(host.DictationFixture(origin), frame =>
                {
                    if (session.Discard) { return; }
                    Task<object> write = ReportSpeech("frame", scope, id, frame);
                    if (!((Task)write).Wait(2500)) { throw new IOException("The speech pipe did not answer."); }
                }, session.End.Token);
                await session.Capture;
                if (speech == session && !session.Stopping) { await FinishDictation(session); }
            }
            catch (Exception error)
            {
                if (speech == session)
                {
                    string problem = error is InvalidOperationException ? error.Message :
                        "Could not use the microphone. Check Windows microphone privacy settings and the selected device.";
                    SendSpeech("error", scope, id, message: problem);
                    CancelDictation(false);
                }
            }
            finally { session.End.Dispose(); }
        }

        async Task FinishDictation(DictationSession session, bool warmed = false)
        {
            if (session.Stopping && !warmed) { return; }
            session.Stopping = true;
            if (session.Capture == null && !warmed) { return; } // Finish when the model is ready.
            session.End.Cancel();
            ShowDictationIndicator(false);
            if (session.Capture != null) { await session.Capture; }
            if (speech != session) { return; }
            await ReportSpeech("stop", session.Scope, session.Id);
        }

        void ShowDictationIndicator(bool show)
        {
            if (IsDisposed || Disposing) { return; }
            if (show && dictationIndicator == null)
            {
                dictationIndicator = new Label { Text = "●  Microphone on — offline dictation", Dock = DockStyle.Top,
                    Height = 27, TabStop = false, TextAlign = ContentAlignment.MiddleCenter, BackColor = Color.DarkRed, ForeColor = Color.White };
                Controls.Add(dictationIndicator);
            }
            if (dictationIndicator != null) { dictationIndicator.Visible = show; dictationIndicator.BringToFront(); }
        }

        internal void CancelDictation(bool notify = true)
        {
            var session = speech;
            if (session == null) { return; }
            speech = null;
            session.Discard = true;
            try { session.End.Cancel(); }
            catch (ObjectDisposedException) { }
            ShowDictationIndicator(false);
            host.Report("dictation.cancel", new { generation = generation, scope = session.Scope, id = session.Id });
            if (notify) { SendSpeech("cancel", session.Scope, session.Id); }
        }

        internal void DetachDictation()
        {
            CancelDictation();
            if (dictationScope != null)
            {
                host.Report("dictation.detach", new { generation = generation, scope = dictationScope });
                dictationScope = null;
            }
        }

        bool SendSpeech(string op, string scope, string id = null, object parts = null, string message = null)
        {
            if (!DictationPage || scope == null) { return false; }
            return bridge.SendDictation(op, scope, id, parts, message);
        }

        const int DictationFixtureMenuMessage = 0x8031; // WM_APP + 49, used by the installer driver.

        bool ShowDictationFixtureMenu()
        {
            // Only a focused loopback view with the isolated PCM fixture can open this menu by message.
            if (host == null || !HasDictation || !DictationFocus || host.DictationFixture(origin) == null) { return false; }
            BeginInvoke((MethodInvoker)delegate { host.ShowDictationFixtureMenu(this); });
            return true;
        }

        internal bool SendDictationKey(string op)
        {
            if (!DictationFocus || !HasDictation) { return false; }
            return SendSpeech(op, dictationScope);
        }

        internal async Task DictationResult(object data)
        {
            var session = speech;
            if (session == null || !HasDictationScope(data) || session.Id != ShellWire.Text(data, "id")) { return; }
            string op = ShellWire.Text(data, "type");
            if (op == "stop") { await FinishDictation(session); return; }
            if (!DictationFocus) { CancelDictation(); return; }
            SendSpeech(op, session.Scope, session.Id, ShellWire.Get(data, "parts"), ShellWire.Text(data, "message"));
            if (op == "end" || op == "empty" || op == "error") { CancelDictation(false); }
        }
    }
}
