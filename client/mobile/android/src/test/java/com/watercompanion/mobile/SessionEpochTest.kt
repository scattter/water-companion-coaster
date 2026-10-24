package com.watercompanion.mobile

import org.junit.Assert.*
import org.junit.Test

class SessionEpochTest {
    @Test fun lateRepliesCannotRestorePreviousAccountOrBinding() {
        val first = Binding("user-a", "device-a", "batch-a")
        val epoch = SessionEpoch(7, first)
        val before = epoch.value
        assertFalse(epoch.observe(first))
        assertTrue(epoch.accepts(before))
        assertTrue(epoch.observe(first.copy(batch = "batch-b")))
        assertFalse(epoch.accepts(before))
        val changed = epoch.value
        assertTrue(epoch.observe(Binding("user-b", "device-a", "batch-b")))
        assertFalse(epoch.accepts(changed))
        assertTrue(epoch.observe(null))
        assertNull(epoch.binding)
    }

    @Test fun serverChangeAndLoginInvalidateEvenUnchangedBindings() {
        val epoch = SessionEpoch(1, null)
        val anonymous = epoch.value
        epoch.advance()
        assertFalse(epoch.accepts(anonymous))
        val login = epoch.value
        epoch.observe(Binding("user", null, null))
        assertFalse(epoch.accepts(login))
    }

    @Test fun widgetsShareOneScheduleUntilLastRemovalOrLogout() {
        assertEquals(15L, WidgetSchedule.MINUTES)
        assertTrue(WidgetSchedule.enabled(1, true))
        assertTrue(WidgetSchedule.enabled(3, true))
        assertFalse(WidgetSchedule.enabled(0, true))
        assertFalse(WidgetSchedule.enabled(2, false))
    }
}
