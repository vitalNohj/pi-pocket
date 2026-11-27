using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace PiPocket
{
    static class TaskbarBadge
    {
        public static readonly int ButtonCreated = RegisterWindowMessage("TaskbarButtonCreated");

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int RegisterWindowMessage(string name);

        [DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr icon);

        [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
        class TaskbarList { }

        [ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface ITaskbarList3
        {
            // All methods before SetOverlayIcon, in vtable order, including those from ITaskbarList and ITaskbarList2.
            void HrInit();
            void AddTab(IntPtr window);
            void DeleteTab(IntPtr window);
            void ActivateTab(IntPtr window);
            void SetActiveAlt(IntPtr window);
            void MarkFullscreenWindow(IntPtr window, [MarshalAs(UnmanagedType.Bool)] bool fullScreen);
            void SetProgressValue(IntPtr window, ulong completed, ulong total);
            void SetProgressState(IntPtr window, int flags);
            void RegisterTab(IntPtr tab, IntPtr window);
            void UnregisterTab(IntPtr tab);
            void SetTabOrder(IntPtr tab, IntPtr before);
            void SetTabActive(IntPtr tab, IntPtr window, uint flags);
            void ThumbBarAddButtons(IntPtr window, uint count, IntPtr buttons);
            void ThumbBarUpdateButtons(IntPtr window, uint count, IntPtr buttons);
            void ThumbBarSetImageList(IntPtr window, IntPtr imageList);
            void SetOverlayIcon(IntPtr window, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string description);
        }

        public static Icon TrayDot(Icon source)
        {
            using (Bitmap image = source.ToBitmap())
            using (Graphics graphics = Graphics.FromImage(image))
            using (Brush red = new SolidBrush(Color.FromArgb(195, 30, 48)))
            {
                float size = Math.Max(6f, image.Width / 2f);
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.FillEllipse(Brushes.White, image.Width - size - 1, image.Height - size - 1, size + 1, size + 1);
                graphics.FillEllipse(red, image.Width - size, image.Height - size, size - 1, size - 1);
                IntPtr handle = image.GetHicon();
                try { using (Icon overlay = Icon.FromHandle(handle)) { return (Icon)overlay.Clone(); } }
                finally { DestroyIcon(handle); }
            }
        }

        public static void Set(IntPtr window, int count)
        {
            object shell = null;
            IntPtr icon = IntPtr.Zero;

            try
            {
                shell = new TaskbarList();
                ITaskbarList3 taskbar = shell as ITaskbarList3;

                if (taskbar == null)
                {
                    return;
                }

                taskbar.HrInit();

                if (count > 0)
                {
                    using (Bitmap image = new Bitmap(32, 32))
                    using (Graphics graphics = Graphics.FromImage(image))
                    using (Brush red = new SolidBrush(Color.FromArgb(180, 30, 48)))
                    using (Font font = new Font("Segoe UI", count > 99 ? 12 : 17, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (StringFormat center = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    {
                        graphics.SmoothingMode = SmoothingMode.AntiAlias;
                        graphics.FillEllipse(red, 0, 0, 32, 32);
                        graphics.DrawString(count > 99 ? "99+" : count.ToString(), font, Brushes.White,
                            new RectangleF(0, 0, 32, 32), center);
                        icon = image.GetHicon();
                    }
                }

                taskbar.SetOverlayIcon(window, icon, count > 0 ? count + " sessions need you" : "");
            }
            catch (COMException)
            {
                // Explorer may not have the taskbar button yet. TaskbarButtonCreated tries again.
            }
            finally
            {
                if (icon != IntPtr.Zero)
                {
                    DestroyIcon(icon);
                }

                if (shell != null)
                {
                    Marshal.ReleaseComObject(shell);
                }
            }
        }
    }
}
