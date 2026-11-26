using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// One invocation owns one CLI process and its tree. It doesn't look up or take over other runners.
static class ProcessesRunner
{
    const uint StartSuspended = 0x4;
    const uint NoWindow = 0x08000000;
    const int UseStdHandles = 0x100;
    const int KillOnClose = 0x2000;
    const int ExtendedLimits = 9;
    const int Unavailable = 125;

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobLimits
    {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes
    {
        public int Size;
        public IntPtr Descriptor;
        public int Inherit;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill;
        public int Flags;
        public short Show, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref JobLimits limits, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(SafeFileHandle job, uint status);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, ref SecurityAttributes attributes,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr from, IntPtr source, IntPtr target, out SafeFileHandle handle,
        uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint status);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out int code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static void Check(bool success)
    {
        if (!success)
            throw new Win32Exception();
    }

    static SafeFileHandle OutputHandle(int id)
    {
        var current = GetCurrentProcess();
        SafeFileHandle handle;
        Check(DuplicateHandle(current, GetStdHandle(id), current, out handle, 0, true, 2));
        return handle;
    }

    static int Run(string node, string[] args)
    {
        var command = new StringBuilder(Quote(node));
        foreach (var argument in args)
            command.Append(' ').Append(Quote(argument));

        using (var job = CreateJobObject(IntPtr.Zero, null))
        using (var output = OutputHandle(-11))
        using (var error = OutputHandle(-12))
        {
            Check(!job.IsInvalid);
            var limits = new JobLimits();
            limits.Basic.Flags = KillOnClose;
            Check(SetInformationJobObject(job, ExtendedLimits, ref limits, Marshal.SizeOf(typeof(JobLimits))));
            var security = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
            using (var input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero))
            {
                Check(!input.IsInvalid);
                var startup = new StartupInfo {
                    Size = Marshal.SizeOf(typeof(StartupInfo)), Flags = UseStdHandles,
                    Input = input.DangerousGetHandle(), Output = output.DangerousGetHandle(), Error = error.DangerousGetHandle()
                };
                ProcessInfo child;
                Check(CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, StartSuspended | NoWindow,
                    IntPtr.Zero, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ref startup, out child));
                try
                {
                    // A child that gets to start first could escape the job, even if it is assigned later.
                    if (!AssignProcessToJobObject(job, child.Process))
                    {
                        TerminateProcess(child.Process, Unavailable);
                        throw new Win32Exception();
                    }
                    Check(ResumeThread(child.Thread) != uint.MaxValue);
                    var stop = new Thread(() => {
                        try
                        {
                            while (Console.In.Read() != -1) { }
                            TerminateJobObject(job, 1);
                        }
                        catch (IOException) { }
                        catch (ObjectDisposedException) { }
                    });
                    stop.IsBackground = true;
                    stop.Start();
                    Check(WaitForSingleObject(child.Process, uint.MaxValue) == 0);
                    int code;
                    Check(GetExitCodeProcess(child.Process, out code));
                    return code;
                }
                finally
                {
                    CloseHandle(child.Thread);
                    CloseHandle(child.Process);
                }
            }
        }
    }

    // Windows argv quoting, including quotes and backslashes. No shell sees these arguments.
    static string Quote(string value)
    {
        var escaped = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\')
            {
                slashes++;
                continue;
            }
            escaped.Append('\\', c == '"' ? 2 * slashes + 1 : slashes).Append(c);
            slashes = 0;
        }
        return escaped.Append('\\', 2 * slashes).Append('"').ToString();
    }

    static string Config(string path)
    {
        var dir = new DirectoryInfo(path);
        var user = WindowsIdentity.GetCurrent().User;
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None,
            AccessControlType.Allow));
        dir.Create(security);
        if ((dir.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException();
        dir.SetAccessControl(security);
        var config = new FileInfo(Path.Combine(dir.FullName, "link.json"));
        if (config.Exists && (config.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException();
        return config.FullName;
    }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2 || !Path.IsPathRooted(args[0]))
                return Unavailable;
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string node = Path.Combine(root, "node", "node.exe");
            string runner = Path.Combine(root, "app", "node_modules", "pi-pocket-runner", "bin", "pi-pocket-runner.js");
            if (!File.Exists(node) || !File.Exists(runner))
                return Unavailable;
            string config = Config(args[0]);
            switch (args[1])
            {
                case "status":
                case "unlink":
                    if (args.Length == 2)
                        return Run(node, new[] { runner, args[1], "--config", config });
                    break;
                case "start":
                    if (args.Length == 2)
                        return Run(node, new[] { runner, "start", "--confirm-via", "stdio", "--config", config });
                    break;
                case "link":
                    if (args.Length == 4 && !args[2].StartsWith("-") && (args[3] == "tls" || args[3] == "allow-http"))
                    {
                        string code = Console.ReadLine();
                        if (code == null || !System.Text.RegularExpressions.Regex.IsMatch(code, "^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){2}$"))
                            return Unavailable;
                        if (args[3] == "allow-http")
                            return Run(node, new[] { runner, "link", args[2], code, "--allow-http", "--config", config });
                        return Run(node, new[] { runner, "link", args[2], code, "--config", config });
                    }
                    break;
            }
        }
        catch (Exception)
        {
            // Arguments, paths and OS exceptions can contain private material.
            Console.Error.WriteLine("Could not start the owned runner process.");
        }
        return Unavailable;
    }
}
