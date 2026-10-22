#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>

static atomic_bool screenSleeping = false;
static atomic_bool sessionInactive = false;
static atomic_bool screenLocked = false;
static atomic_uint_fast64_t wakeGeneration = 0;

void coaster_activity_start(void) {
    NSNotificationCenter *workspace = NSWorkspace.sharedWorkspace.notificationCenter;
    for (NSNotificationName name in @[NSWorkspaceWillSleepNotification, NSWorkspaceScreensDidSleepNotification]) {
        [workspace addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
            atomic_store(&screenSleeping, true);
        }];
    }
    for (NSNotificationName name in @[NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidWakeNotification]) {
        [workspace addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
            atomic_store(&screenSleeping, false);
            atomic_fetch_add(&wakeGeneration, 1);
        }];
    }
    [workspace addObserverForName:NSWorkspaceSessionDidResignActiveNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
        atomic_store(&sessionInactive, true);
    }];
    [workspace addObserverForName:NSWorkspaceSessionDidBecomeActiveNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
        atomic_store(&sessionInactive, false);
        atomic_fetch_add(&wakeGeneration, 1);
    }];
    // 补充锁屏到屏幕真正休眠之间的间隔；仅观察状态，不安装输入监听。
    NSDistributedNotificationCenter *distributed = NSDistributedNotificationCenter.defaultCenter;
    [distributed addObserverForName:@"com.apple.screenIsLocked" object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
        atomic_store(&screenLocked, true);
    }];
    [distributed addObserverForName:@"com.apple.screenIsUnlocked" object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
        atomic_store(&screenLocked, false);
        atomic_fetch_add(&wakeGeneration, 1);
    }];
}

double coaster_idle_seconds(void) {
    return CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType);
}

bool coaster_suspended(void) {
    return atomic_load(&screenSleeping) || atomic_load(&sessionInactive) || atomic_load(&screenLocked);
}

uint64_t coaster_wake_generation(void) {
    return atomic_load(&wakeGeneration);
}
