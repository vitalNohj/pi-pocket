using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace PiPocket
{
    // WASAPI converts the device mix to signed, mono 16-bit PCM at 16 kHz in shared mode.
    static class DictationCapture
    {
        const int FrameBytes = 1600;
        const int Silent = 2;
        const uint AutoConvertPcm = 0x80000000;
        const uint DefaultQuality = 0x08000000;

        public static Task Run(string fixture, Action<byte[]> output, CancellationToken cancel)
        {
            return Task.Run(delegate
            {
                var frames = new Frames(output);

                if (fixture != null)
                {
                    using (var file = new FileStream(fixture, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        if (file.Length > 3840000 || (file.Length & 1) != 0) { throw new IOException("Invalid PCM fixture."); }
                        var block = new byte[640];
                        int count;
                        while (!cancel.IsCancellationRequested && (count = file.Read(block, 0, block.Length)) > 0)
                        {
                            frames.Append(block, count);
                            if (cancel.WaitHandle.WaitOne(20)) { break; }
                        }
                    }
                }
                else { Capture(frames, cancel); }

                frames.Flush();
            });
        }

        static void Capture(Frames frames, CancellationToken cancel)
        {
            IMMDeviceEnumerator devices = null;
            IMMDevice device = null;
            IAudioClient client = null;
            IAudioCaptureClient source = null;
            bool started = false;

            try
            {
                devices = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
                Check(devices.GetDefaultAudioEndpoint(1, 0, out device)); // capture, console role
                Guid id = typeof(IAudioClient).GUID;
                object instance;
                Check(device.Activate(ref id, 23, IntPtr.Zero, out instance));
                client = (IAudioClient)instance;
                var format = new WaveFormat { tag = 1, channels = 1, samples = 16000, bytes = 32000, block = 2, bits = 16, extra = 0 };
                Check(client.Initialize(0, AutoConvertPcm | DefaultQuality, 1000000, 0, ref format, IntPtr.Zero));
                id = typeof(IAudioCaptureClient).GUID;
                Check(client.GetService(ref id, out instance));
                source = (IAudioCaptureClient)instance;
                Check(client.Start());
                started = true;

                var bytes = new byte[32000];
                while (!cancel.IsCancellationRequested)
                {
                    uint next;
                    Check(source.GetNextPacketSize(out next));
                    while (next > 0 && !cancel.IsCancellationRequested)
                    {
                        IntPtr data;
                        uint count, flags;
                        Check(source.GetBuffer(out data, out count, out flags, IntPtr.Zero, IntPtr.Zero));
                        try
                        {
                            if (count > bytes.Length / 2) { throw new IOException("Invalid microphone buffer."); }
                            int length = (int)count * 2;
                            if ((flags & Silent) != 0) { Array.Clear(bytes, 0, length); }
                            else { Marshal.Copy(data, bytes, 0, length); }
                            frames.Append(bytes, length);
                        }
                        finally { Check(source.ReleaseBuffer(count)); }
                        Check(source.GetNextPacketSize(out next));
                    }
                    if (cancel.WaitHandle.WaitOne(10)) { break; }
                }
            }
            finally
            {
                if (started) { client.Stop(); }
                if (source != null) { Marshal.ReleaseComObject(source); }
                if (client != null) { Marshal.ReleaseComObject(client); }
                if (device != null) { Marshal.ReleaseComObject(device); }
                if (devices != null) { Marshal.ReleaseComObject(devices); }
            }
        }

        static void Check(int hr) { Marshal.ThrowExceptionForHR(hr); }

        sealed class Frames
        {
            readonly Action<byte[]> write;
            byte[] data = new byte[FrameBytes];
            int filled;

            public Frames(Action<byte[]> write) { this.write = write; }

            public void Append(byte[] bytes, int length)
            {
                for (int i = 0; i < length;)
                {
                    int copy = Math.Min(data.Length - filled, length - i);
                    Buffer.BlockCopy(bytes, i, data, filled, copy);
                    i += copy;
                    filled += copy;
                    if (filled == data.Length) { Flush(); }
                }
            }

            public void Flush()
            {
                if (filled == 0) { return; }
                write(data);
                filled = 0;
                data = new byte[FrameBytes];
            }
        }

        [StructLayout(LayoutKind.Sequential, Pack = 2)]
        struct WaveFormat
        {
            public ushort tag, channels;
            public uint samples, bytes;
            public ushort block, bits, extra;
        }

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid id, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        }

        [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioClient
        {
            [PreserveSig] int Initialize(int share, uint flags, long duration, long period, ref WaveFormat format, IntPtr session);
            [PreserveSig] int GetBufferSize(out uint frames);
            [PreserveSig] int GetStreamLatency(out long latency);
            [PreserveSig] int GetCurrentPadding(out uint frames);
            [PreserveSig] int IsFormatSupported(int share, IntPtr format, out IntPtr closest);
            [PreserveSig] int GetMixFormat(out IntPtr format);
            [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
            [PreserveSig] int Start();
            [PreserveSig] int Stop();
            [PreserveSig] int Reset();
            [PreserveSig] int SetEventHandle(IntPtr handle);
            [PreserveSig] int GetService(ref Guid id, [MarshalAs(UnmanagedType.IUnknown)] out object service);
        }

        [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioCaptureClient
        {
            [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, IntPtr devicePosition, IntPtr time);
            [PreserveSig] int ReleaseBuffer(uint frames);
            [PreserveSig] int GetNextPacketSize(out uint frames);
        }
    }
}
