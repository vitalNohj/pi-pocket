using System;
using Microsoft.Web.WebView2.Core;

namespace PiPocket
{
    internal static class WindowContextMenu
    {
        public static void Add(CoreWebView2 browser, CoreWebView2Environment environment, string origin, Action openOptions)
        {
            browser.ContextMenuRequested += delegate(object sender, CoreWebView2ContextMenuRequestedEventArgs args)
            {
                if (!args.ContextMenuTarget.IsRequestedForMainFrame || !PocketWindow.IsServerAddress(browser.Source, origin))
                {
                    return;
                }

                // Let WebView2 draw and operate all of its own items, including keyboard access and spelling.
                var entry = environment.CreateContextMenuItem("Window options…", null, CoreWebView2ContextMenuItemKind.Command);
                entry.CustomItemSelected += delegate { openOptions(); };
                args.MenuItems.Add(environment.CreateContextMenuItem(string.Empty, null, CoreWebView2ContextMenuItemKind.Separator));
                args.MenuItems.Add(entry);
            };
        }
    }
}
