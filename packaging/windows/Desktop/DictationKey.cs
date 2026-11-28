using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace PiPocket
{
    // Do not consume or record keys. Track only the chosen binding, and discard it outside a Pi Pocket view.
    sealed class DictationKey : IDisposable
    {
        readonly Func<PocketWindow> front;
        readonly Func<string[]> preference;
        readonly Hook handler;
        readonly IntPtr hook;
        readonly Timer hold = new Timer { Interval = 300 };
        PocketWindow target;
        int down;
        bool held;
        string mode;

        public DictationKey(Func<PocketWindow> front, Func<string[]> preference)
        {
            this.front = front;
            this.preference = preference;
            hold.Tick += delegate
            {
                hold.Stop();
                if (target == front() && target != null && mode != "tap") { held = target.SendDictationKey("hold"); }
            };
            handler = OnKey;
            hook = SetWindowsHookEx(13, handler, GetModuleHandle(null), 0);
        }

        static bool Pressed(int key) { return GetAsyncKeyState(key) < 0; }

        IntPtr OnKey(int code, IntPtr message, IntPtr data)
        {
            if (code >= 0)
            {
                try { Update(message.ToInt32(), data); }
                catch (InvalidOperationException) { Reset(); }
            }
            return CallNextHookEx(hook, code, message, data);
        }

        void Update(int message, IntPtr data)
        {
            PocketWindow page = front();
            if (page == null || !page.HasDictation || page.Handle != GetForegroundWindow()) { Reset(); return; }
            if ((Marshal.ReadInt32(data, 8) & 0x10) != 0) { return; } // Ignore injected input.
            int key = Marshal.ReadInt32(data);
            var prefs = preference();
            int binding = prefs[0] == "F8" ? 0x77 : prefs[0] == "F9" ? 0x78 :
                prefs[0] == "primary-shift-d" ? 0x44 : prefs[0] == "default" ? 0xA3 : 0;
            bool release = message == 0x101 || message == 0x105;
            bool press = message == 0x100 || message == 0x104;
            if (target != null)
            {
                if (target != page || binding != down || (key != down && (press || prefs[0] == "primary-shift-d")))
                {
                    if (held && target == page) { target.CancelDictation(); }
                    Reset();
                }
                else if (key == down && release)
                {
                    if (held) { target.SendDictationKey("release"); }
                    else if (mode == "tap" || mode != "hold" && hold.Enabled) { target.SendDictationKey("toggle"); }
                    Reset();
                }
                return;
            }
            if (!press || key != binding || binding == 0 || Pressed(binding)) { return; }
            bool shift = Pressed(0x10), ctrl = Pressed(0x11);
            if (Pressed(0x12) || Pressed(0x5B) || Pressed(0x5C) ||
                (binding == 0x44 ? !shift || !ctrl : shift || ctrl)) { return; }
            target = page;
            down = key;
            mode = prefs[1];
            // Keep the time limit for a long press in Both mode.
            hold.Start();
        }

        void Reset()
        {
            hold.Stop();
            target = null;
            down = 0;
            held = false;
        }

        public void Dispose()
        {
            if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); }
            Reset();
            hold.Dispose();
        }

        delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
        [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, Hook handler, IntPtr module, uint thread);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    }
}
