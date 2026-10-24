package com.watercompanion.mobile

import org.junit.Assert.*
import org.junit.Test

class WidgetRefreshTest {
    @Test fun aClickShowsFeedbackAndIgnoresRepeatedClicksUntilFinished() {
        val state = WidgetRefresh()
        assertTrue(state.request("manual"))
        assertEquals("等待刷新…", state.message())
        assertFalse(state.request("duplicate"))
        state.start("manual")
        assertEquals("正在刷新…", state.message())
        assertFalse(state.request("duplicate"))
        state.finish("manual")
        assertNull(state.message())
        assertTrue(state.request("next"))
    }

    @Test fun finishingPeriodicWorkDoesNotHidePendingOrRunningManualWork() {
        val state = WidgetRefresh()
        state.request("manual")
        state.start("periodic")
        state.finish("periodic")
        assertEquals("等待刷新…", state.message())
        state.start("manual")
        state.start("periodic-next")
        state.finish("manual")
        assertEquals("正在刷新…", state.message())
        state.finish("periodic-next")
        assertNull(state.message())
    }

    @Test fun discardedRequestsAndLogoutCannotLeaveTheSpinnerStuck() {
        val state = WidgetRefresh()
        state.request("discarded")
        state.cancelRequest("discarded")
        assertNull(state.message())
        state.request("next")
        state.cancelRequest("discarded")
        assertEquals("等待刷新…", state.message())
        state.start("next")
        state.reset()
        assertNull(state.message())
        state.request("new-account")
        state.finish("next")
        assertEquals("等待刷新…", state.message())
        state.reset()
        assertNull(state.message())
    }
}
