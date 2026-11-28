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
        readonly Action toggle;
        int registered;
        uint previousModifiers, previousKey;

        public WindowHotkey(Action toggle)
        {
            this.toggle = toggle;
            CreateHandle(new CreateParams { Parent = new IntPtr(-3) }); // HWND_MESSAGE
        }

        public bool Active { get { return registered != 0; } }

        public bool Bind(string shortcut)
        {
            if (string.IsNullOrEmpty(shortcut)) { return false; }
            string[] parts = shortcut.Split('+');
            string key = parts[parts.Length - 1];
            if (key.Length != 1 || !(key[0] >= 'A' && key[0] <= 'Z' || key[0] >= '0' && key[0] <= '9')) { return false; }
            uint modifiers = 0;
            for (int i = 0; i < parts.Length - 1; i++)
            {
                switch (parts[i])
                {
                    case "Ctrl": modifiers |= 2; break;
                    case "Alt": modifiers |= 1; break;
                    case "Meta": modifiers |= 8; break;
                    case "Shift": modifiers |= 4; break;
                    default: return false;
                }
            }
            return (modifiers & ~4u) != 0 && Bind(modifiers, key[0]);
        }

        bool Bind(uint modifiers, uint key)
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
