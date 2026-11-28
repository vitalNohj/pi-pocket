#import "WebViewBackground.h"

BOOL PocketSetWebViewDrawsBackground(WKWebView *view, BOOL drawsBackground) {
    // The public underPageBackgroundColor only paints behind the page, not the page's backing store.
    // Keep the private WebKit key and the Objective-C exception boundary out of Swift.
    @try {
        if (![view respondsToSelector:NSSelectorFromString(@"setDrawsBackground:")] &&
            ![view respondsToSelector:NSSelectorFromString(@"_setDrawsBackground:")]) {
            return NO;
        }
        [view setValue:@(drawsBackground) forKey:@"drawsBackground"];
        return YES;
    } @catch (NSException *exception) {
        return NO;
    }
}
