#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

static __weak NSWindow *panelWindow;
static __weak NSStatusItem *panelStatusItem;
static NSSize panelSize;
static id localMouseMonitor;
static id globalMouseMonitor;

void coaster_panel_setup(void *windowPointer, void *statusItemPointer) {
    NSWindow *window = (__bridge NSWindow *)windowPointer;
    panelWindow = window;
    panelStatusItem = (__bridge NSStatusItem *)statusItemPointer;
    panelSize = window.frame.size;

    window.opaque = NO;
    window.backgroundColor = NSColor.clearColor;
    window.hasShadow = YES;
    window.movable = NO;
    window.excludedFromWindowsMenu = YES;
    window.collectionBehavior |= NSWindowCollectionBehaviorCanJoinAllSpaces
        | NSWindowCollectionBehaviorFullScreenAuxiliary
        | NSWindowCollectionBehaviorTransient
        | NSWindowCollectionBehaviorIgnoresCycle;
    window.contentView.wantsLayer = YES;
    window.contentView.layer.cornerRadius = 12;
    window.contentView.layer.masksToBounds = YES;

    NSEventMask clicks = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown;
    // 菜单栏点击留给托盘的松开事件处理，避免先收起又被同一次点击重新打开。
    localMouseMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:clicks handler:^NSEvent *(NSEvent *event) {
        if (event.window != panelWindow && event.window != panelStatusItem.button.window) {
            [panelWindow orderOut:nil];
        }
        return event;
    }];
    globalMouseMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:clicks handler:^(NSEvent *event) {
        (void)event;
        [panelWindow orderOut:nil];
    }];
    [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidResignActiveNotification
        object:NSApp queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
            [panelWindow orderOut:nil];
        }];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification
        object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
            [panelWindow orderOut:nil];
        }];
}

void coaster_panel_position(void) {
    NSWindow *window = panelWindow;
    NSStatusBarButton *button = panelStatusItem.button;
    NSWindow *statusWindow = button.window;
    NSScreen *screen = statusWindow.screen;
    if (!window) return;
    if (!screen || NSIsEmptyRect(button.bounds)) {
        [window center];
        return;
    }

    // AppKit 的屏幕坐标统一使用点，避免跨 Retina/普通屏幕时混用物理像素。
    NSRect anchor = [statusWindow convertRectToScreen:[button convertRect:button.bounds toView:nil]];
    NSRect area = screen.visibleFrame;
    CGFloat margin = 8;
    CGFloat top = MIN(NSMinY(anchor), NSMaxY(area)) - 4;
    CGFloat width = MIN(panelSize.width, MAX(1, NSWidth(area) - margin * 2));
    CGFloat height = MIN(panelSize.height, MAX(1, top - NSMinY(area) - margin));
    CGFloat x = MAX(NSMinX(area) + margin,
        MIN(NSMidX(anchor) - width / 2, NSMaxX(area) - margin - width));
    [window setFrame:NSMakeRect(x, top - height, width, height) display:NO];
    [window invalidateShadow];
}
