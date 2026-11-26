using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace PiPocket
{
    // The OS owns the binding. Register the new one before releasing the old one on a change.
    internal sealed class WindowHotkey : NativeWindow, IDisposable
    {
        const int WM_HOTKEY = 0x0312;
        const uint NoRepeat = 0x4000;
        public const uint DefaultModifiers = 0x0002 | 0x0004; // Ctrl + Shift
        public const uint DefaultKey = 0x50; // P
        readonly Action toggle;
        int registered;
        uint previousModifiers, previousKey;

        public WindowHotkey(Action toggle)
        {
            this.toggle = toggle;
            CreateHandle(new CreateParams { Parent = new IntPtr(-3) }); // HWND_MESSAGE
        }

        public bool Bind(uint modifiers, uint key)
        {
            if (registered != 0 && previousModifiers == modifiers && previousKey == key) { return true; }

            int next = registered == 1 ? 2 : 1;
            if (!RegisterHotKey(Handle, next, modifiers | NoRepeat, key)) { return false; }

            Clear();
            registered = next;
            previousModifiers = modifiers;
            previousKey = key;
            return true;
        }

        public void Clear()
        {
            if (registered == 0) { return; }
            UnregisterHotKey(Handle, registered);
            registered = 0;
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WM_HOTKEY && registered != 0 && message.WParam.ToInt32() == registered) { toggle(); }
            base.WndProc(ref message);
        }

        public void Dispose()
        {
            Clear();
            DestroyHandle();
        }

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UnregisterHotKey(IntPtr window, int id);
    }
}
