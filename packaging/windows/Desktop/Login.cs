using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace PiPocket
{
    internal static class WindowLogin
    {
        const string Name = "Pi Pocket.lnk";
        const string Approved = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";
        static string Link { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), Name); } }

        public static bool Enabled
        {
            get
            {
                if (!File.Exists(Link)) { return false; }

                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Approved))
                {
                    byte[] status = key == null ? null : key.GetValue(Name) as byte[];
                    // Task Manager can disable a Startup shortcut without removing it.
                    return status == null || status.Length == 0 || (status[0] & 1) == 0;
                }
            }
        }

        public static void Set(bool on)
        {
            if (!on)
            {
                File.Delete(Link);
                return;
            }

            // Keep the platform's existing per-user Startup mechanism (and its ability to disable us).
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true));
            object shortcut = null;

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Link));
                shortcut = Call(shell, "CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, Link);
                Call(shortcut, "TargetPath", System.Reflection.BindingFlags.SetProperty, Application.ExecutablePath);
                Call(shortcut, "WorkingDirectory", System.Reflection.BindingFlags.SetProperty,
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
                Call(shortcut, "Arguments", System.Reflection.BindingFlags.SetProperty, "--login");
                Call(shortcut, "Save", System.Reflection.BindingFlags.InvokeMethod);

                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Approved, true))
                {
                    if (key != null) { key.DeleteValue(Name, false); }
                }
            }
            finally
            {
                if (shortcut != null) { Marshal.FinalReleaseComObject(shortcut); }
                Marshal.FinalReleaseComObject(shell);
            }
        }

        public static void UpdateLegacyShortcut()
        {
            if (!Enabled) { return; }
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true));
            object shortcut = null;
            try
            {
                shortcut = Call(shell, "CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, Link);
                string arguments = Call(shortcut, "Arguments", System.Reflection.BindingFlags.GetProperty) as string;
                if (arguments == "--hidden")
                {
                    Call(shortcut, "Arguments", System.Reflection.BindingFlags.SetProperty, "--login");
                    Call(shortcut, "Save", System.Reflection.BindingFlags.InvokeMethod);
                }
            }
            finally
            {
                if (shortcut != null) { Marshal.FinalReleaseComObject(shortcut); }
                Marshal.FinalReleaseComObject(shell);
            }
        }

        static object Call(object target, string member, System.Reflection.BindingFlags flags, params object[] args)
        {
            return target.GetType().InvokeMember(member, flags, null, target, args);
        }
    }
}
