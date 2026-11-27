using System;
using System.Diagnostics;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace PiPocket
{
    static class DesktopUpdates
    {
        // The updater runs before this instance creates any app-owned processes.
        public static bool TakeStagedUpdate(bool hidden)
        {
            string app = Application.ExecutablePath;
            string root = Path.GetDirectoryName(app);
            string cache = Path.Combine(root, "desktop-update-cache");
            if (!File.Exists(Path.Combine(cache, "pending.json")) && !File.Exists(Path.Combine(cache, "applying.json")))
            {
                return false;
            }

            using (Process self = Process.GetCurrentProcess())
            {
                string helper = Path.Combine(root, @"desktop-assets\controller\updates\desktop-updates.mjs");
                ProcessStartInfo start = new ProcessStartInfo(Path.Combine(root, @"node\node.exe"),
                    Quote(helper) + " handoff " + Quote(Program.Version) + " " + Quote(app) + " " + self.Id +
                    (hidden ? " --hidden" : ""));
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardOutput = true;
                start.EnvironmentVariables.Remove("NODE_OPTIONS");

                try
                {
                    using (Process process = Process.Start(start))
                    {
                        if (!process.WaitForExit(5000) || process.ExitCode != 0)
                        {
                            return false;
                        }

                        var state = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                            process.StandardOutput.ReadToEnd());
                        object phase;
                        return state.TryGetValue("phase", out phase) &&
                            (Equals(phase, "handoff") || Equals(phase, "busy"));
                    }
                }
                catch (Exception)
                {
                    // An incomplete install must still reach the desktop app's repair message.
                    return false;
                }
            }
        }

        // Setup did not change the runtime during a desktop-only update. Check its original floor.
        public static string RuntimeFloor(string marker)
        {
            try
            {
                string text = File.ReadAllText(marker);
                const string prefix = "Pi Pocket Setup ";
                int end = text.IndexOf(' ', prefix.Length);
                if (text.StartsWith(prefix, StringComparison.Ordinal) && end > prefix.Length)
                {
                    return text.Substring(prefix.Length, end - prefix.Length);
                }
            }
            catch (Exception)
            {
                // Fall back to the old check if Setup did not write its version.
            }

            return Program.Version;
        }

        static string Quote(string value)
        {
            return "\"" + value + "\"";
        }
    }
}
