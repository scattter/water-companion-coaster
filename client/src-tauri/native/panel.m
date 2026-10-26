#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

static __weak NSWindow *panelWindow;
static __weak NSStatusItem *panelStatusItem;
static NSSize panelSize;
static id localMouseMonitor;
static id globalMouseMonitor;

@interface CoasterAmountView : NSView
@property(nonatomic, weak) NSStatusBarButton *button;
@property(nonatomic, copy) NSString *text;
@property(nonatomic, copy) NSString *previous;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic) CFTimeInterval started;
@property(nonatomic) CGFloat progress;
- (void)showText:(NSString *)text animate:(BOOL)animate;
@end

@implementation CoasterAmountView
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }

- (void)showText:(NSString *)text animate:(BOOL)animate {
    if ([self.text isEqualToString:text]) return;
    [self.timer invalidate];
    self.timer = nil;
    self.previous = self.text;
    self.text = text;
    self.progress = 1;
    if (animate && self.previous.length) {
        self.progress = 0;
        self.started = CACurrentMediaTime();
        __weak CoasterAmountView *view = self;
        self.timer = [NSTimer timerWithTimeInterval:1.0 / 60.0 repeats:YES block:^(NSTimer *timer) {
            CoasterAmountView *current = view;
            if (!current) { [timer invalidate]; return; }
            CGFloat elapsed = MIN(1, CACurrentMediaTime() - current.started);
            CGFloat low = 0, high = 1, t = 0;
            for (int i = 0; i < 16; i++) {
                t = (low + high) / 2;
                CGFloat x = 3 * (1 - t) * (1 - t) * t * .22 + 3 * (1 - t) * t * t * .24 + t * t * t;
                if (x < elapsed) low = t; else high = t;
            }
            current.progress = elapsed >= 1 ? 1 : 3 * (1 - t) * (1 - t) * t * .75 + 3 * (1 - t) * t * t + t * t * t;
            current.needsDisplay = YES;
            if (elapsed >= 1) {
                [timer invalidate];
                current.timer = nil;
                current.previous = nil;
            }
        }];
        [NSRunLoop.mainRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];
    }
    self.needsDisplay = YES;
}

- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    NSStatusBarButton *button = self.button;
    NSRect titleRect = [button.cell titleRectForBounds:button.bounds];
    titleRect = [self convertRect:titleRect fromView:button];
    NSFont *font = button.font ?: [NSFont menuBarFontOfSize:0];
    NSColor *color = button.highlighted ? NSColor.selectedMenuItemTextColor : NSColor.labelColor;
    CGFloat height = [self.text sizeWithAttributes:@{NSFontAttributeName:font}].height;
    CGFloat y = NSMidY(titleRect) - height / 2;
    CGFloat distance = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion ? 0 : NSHeight(titleRect);
    [NSGraphicsContext saveGraphicsState];
    NSRectClip(titleRect);
    if (self.previous && self.progress < 1) {
        [self.previous drawAtPoint:NSMakePoint(NSMinX(titleRect), y - distance * self.progress)
            withAttributes:@{NSFontAttributeName:font, NSForegroundColorAttributeName:[color colorWithAlphaComponent:1 - self.progress]}];
    }
    [self.text drawAtPoint:NSMakePoint(NSMinX(titleRect), y + distance * (1 - self.progress))
        withAttributes:@{NSFontAttributeName:font, NSForegroundColorAttributeName:[color colorWithAlphaComponent:self.progress]}];
    [NSGraphicsContext restoreGraphicsState];
}
@end

static CoasterAmountView *amountView;

void coaster_status_title(const char *value, bool animate) {
    NSStatusBarButton *button = panelStatusItem.button;
    if (!button) return;
    NSString *text = [NSString stringWithUTF8String:value];
    if (!text) return;
    if (!amountView) {
        amountView = [[CoasterAmountView alloc] initWithFrame:button.bounds];
        amountView.button = button;
        amountView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [button addSubview:amountView];
    }
    // 原生标题继续决定按钮宽度与图文间距，仅将文字交给覆层绘制。
    button.attributedTitle = [[NSAttributedString alloc] initWithString:text attributes:@{
        NSFontAttributeName:button.font ?: [NSFont menuBarFontOfSize:0],
        NSForegroundColorAttributeName:NSColor.clearColor
    }];
    button.accessibilityLabel = [NSString stringWithFormat:@"饮水陪伴 %@", text];
    [amountView showText:text animate:animate];
}

void coaster_panel_setup(void *windowPointer, void *statusItemPointer) {
    NSWindow *window = (__bridge NSWindow *)windowPointer;
    panelWindow = window;
    panelStatusItem = (__bridge NSStatusItem *)statusItemPointer;
    panelSize = window.frame.size;
    coaster_status_title(panelStatusItem.button.title.UTF8String, false);

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
        [window setContentSize:panelSize];
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

void coaster_panel_resize(double height) {
    // 保留内容的完整高度，屏幕限高仅在定位时应用，重新展开时仍能恢复。
    panelSize.height = height;
    coaster_panel_position();
}
