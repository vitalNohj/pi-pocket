using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace PiPocket
{
    static class ShellWire
    {
        public const int MaxBytes = 65536;
        public static JavaScriptSerializer Serializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = MaxBytes, RecursionLimit = 12 };
        }

        public static Dictionary<string, object> Object(object value)
        {
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        public static object Get(object value, string key)
        {
            object item;
            return Object(value).TryGetValue(key, out item) ? item : null;
        }

        public static string Text(object value, string key) { return Get(value, key) as string; }
        public static bool Flag(object value, string key) { return true.Equals(Get(value, key)); }
        public static int Number(object value, string key) { return Get(value, key) is int ? (int)Get(value, key) : 0; }

        public static IEnumerable<object> Items(object value)
        {
            // JavaScriptSerializer can return an ArrayList for nested arrays.
            IList items = value as IList;
            if (items == null) { yield break; }
            foreach (object item in items) { yield return item; }
        }
    }

    sealed class ShellController : IDisposable
    {
        readonly BlockingCollection<string> output = new BlockingCollection<string>(64);
        readonly Dictionary<int, TaskCompletionSource<object>> pending = new Dictionary<int, TaskCompletionSource<object>>();
        readonly Process child;
        readonly Action<Dictionary<string, object>> received;
        readonly Action disconnected;
        bool stopped;
        int next;

        public ShellController(ProcessStartInfo start, Action<Dictionary<string, object>> received, Action disconnected)
        {
            this.received = received;
            this.disconnected = disconnected;
            child = new Process { StartInfo = start };
            new Thread(Read) { IsBackground = true }.Start();
        }

        void Read()
        {
            try
            {
                if (output.IsAddingCompleted) { return; }
                child.Start();
                new Thread(Write) { IsBackground = true }.Start();
                JavaScriptSerializer json = ShellWire.Serializer();
                string line;

                while ((line = child.StandardOutput.ReadLine()) != null)
                {
                    if (Encoding.UTF8.GetByteCount(line) > ShellWire.MaxBytes) { break; }
                    Dictionary<string, object> packet = json.Deserialize<Dictionary<string, object>>(line);

                    if (ShellWire.Number(packet, "v") != 1) { continue; }
                    if (ShellWire.Text(packet, "type") == "result")
                    {
                        TaskCompletionSource<object> request;
                        int id = ShellWire.Number(packet, "id");

                        lock (pending)
                        {
                            if (!pending.TryGetValue(id, out request)) { continue; }
                            pending.Remove(id);
                        }
                        if (ShellWire.Flag(packet, "ok")) { request.TrySetResult(ShellWire.Get(packet, "value")); }
                        else { request.TrySetException(new InvalidOperationException(ShellWire.Text(ShellWire.Get(packet, "error"), "message"))); }
                    }
                    else
                    {
                        received(packet);
                    }
                }
            }
            catch (IOException) { }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            catch (ArgumentException) { }
            finally
            {
                Dispose();
                disconnected();
            }
        }

        void Write()
        {
            try
            {
                // Use UTF-8 with no BOM, independently of the Windows console code page.
                using (StreamWriter writer = new StreamWriter(child.StandardInput.BaseStream, new UTF8Encoding(false)))
                {
                    writer.NewLine = "\n";
                    writer.AutoFlush = true;
                    foreach (string line in output.GetConsumingEnumerable()) { writer.WriteLine(line); }
                }
            }
            catch (IOException) { }
            catch (InvalidOperationException) { }
        }

        public Task<object> Call(string command, object value = null)
        {
            lock (pending)
            {
                TaskCompletionSource<object> request = new TaskCompletionSource<object>();
                int id = next = next == int.MaxValue ? 1 : next + 1;
                Dictionary<string, object> packet = new Dictionary<string, object> { { "v", 1 }, { "id", id }, { "command", command } };

                if (value != null) { packet["value"] = value; }
                if (stopped || pending.Count >= 48)
                {
                    request.TrySetException(new InvalidOperationException("The desktop controller is not available."));
                    return request.Task;
                }
                pending.Add(id, request);
                if (!output.TryAdd(ShellWire.Serializer().Serialize(packet)))
                {
                    pending.Remove(id);
                    request.TrySetException(new InvalidOperationException("The desktop controller is busy."));
                }
                return request.Task;
            }
        }

        public void Dispose()
        {
            List<TaskCompletionSource<object>> waiting;

            lock (pending)
            {
                if (stopped) { return; }
                stopped = true;
                waiting = new List<TaskCompletionSource<object>>(pending.Values);
                pending.Clear();
                output.CompleteAdding();
            }
            foreach (TaskCompletionSource<object> request in waiting)
            {
                request.TrySetException(new InvalidOperationException("The desktop controller stopped."));
            }
        }
    }
}
