package com.watercompanion.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

class WidgetDataTest {
    private val now = Instant.parse("2026-10-23T06:33:00Z")
    private fun cache() = JSONObject().put("syncedAt", Instant.parse("2026-10-23T06:32:00Z").toEpochMilli())
        .put("offline", false).put("data", JSONObject().put("date", "2026-10-23").put("timeZone", "Asia/Shanghai")
            .put("totals", JSONObject().put("drinkMl", 1280).put("drinkCount", 6)))
    private fun drink(time: String, amount: Double = 180.0) = JSONObject().put("kind", "drink")
        .put("occurredAt", time).put("amountMl", amount).put("revokedAt", JSONObject.NULL)

    @Test fun recentDrinksExcludeRefillsRevokedInvalidAndOtherDays() {
        val cache = cache()
        cache.getJSONObject("data").put("events", JSONArray()
            .put(drink("2026-10-23T03:10:00Z", 160.0))
            .put(drink("2026-10-23T06:30:00Z").put("kind", "refill"))
            .put(drink("2026-10-23T06:29:00Z").put("revokedAt", "2026-10-23T06:31:00Z"))
            .put(drink("2026-10-23T06:20:00Z"))
            .put(drink("2026-10-23T04:45:00Z", 240.5))
            .put(drink("2026-10-22T15:59:00Z"))
            .put(drink("invalid")))
        val data = WidgetData.from(cache, true, now)
        assertEquals("1,280", data.amount)
        assertEquals(6, data.count)
        assertEquals("10/23 14:32 同步", data.sync)
        assertEquals(listOf(WidgetDrink("14:20", "180 ml"), WidgetDrink("12:45", "240.5 ml"), WidgetDrink("11:10", "160 ml")), data.recent)
    }

    @Test fun recentDrinksKeepEveryValidRecordForScrolling() {
        val cache = cache()
        val first = Instant.parse("2026-10-23T05:00:00Z")
        cache.getJSONObject("data").put("events", JSONArray().apply {
            repeat(40) { put(drink(first.plusSeconds(it * 60L).toString())) }
        })
        val data = WidgetData.from(cache, true, now)
        assertEquals(40, data.recent.size)
        assertEquals("13:39", data.recent.first().time)
        assertEquals("13:00", data.recent.last().time)
        assertTrue(WidgetData.from(cache, false, now).recent.isEmpty())
    }

    @Test fun offlineSnapshotKeepsItsDateAfterMidnight() {
        val data = WidgetData.from(cache().put("offline", true), true, Instant.parse("2026-10-23T16:01:00Z"))
        assertEquals("2026-10-23 饮水", data.title)
        assertEquals("10月23日 周五", data.date)
        assertEquals("离线 · 10/23 14:32 同步", data.sync)
        assertEquals(LocalDate.parse("2026-10-23"), data.week.last().date)
    }

    @Test fun todayUsesTheServiceTimezone() {
        val data = WidgetData.from(cache(), true, Instant.parse("2026-10-22T17:00:00Z"))
        assertEquals("今日饮水", data.title)
    }

    @Test fun weekEndsAtSnapshotDateAndDistinguishesMissingDataFromZero() {
        val cache = cache()
        cache.getJSONObject("data").put("date", "2026-10-02").put("week", JSONArray()
            .put(JSONObject().put("date", "2026-09-26").put("drinkMl", 0))
            .put(JSONObject().put("date", "2026-09-28").put("drinkMl", 1600))
            .put(JSONObject().put("date", "2026-10-02").put("drinkMl", 1000))
            .put(JSONObject().put("date", "2026-10-03").put("drinkMl", 9999)))
        val data = WidgetData.from(cache, true, now)
        assertEquals(7, data.week.size)
        assertEquals(LocalDate.parse("2026-09-26"), data.week.first().date)
        assertEquals(0.0, data.week.first().amount)
        assertNull(data.week[1].amount)
        assertEquals(1600.0, data.week[2].amount)
        assertEquals(LocalDate.parse("2026-10-02"), data.week.last().date)
        assertEquals(1280.0, data.week.last().amount)
    }

    @Test fun loggedOutAndWaitingStatesDoNotShowCachedNumbers() {
        val loggedOut = WidgetData.from(cache(), false, now)
        assertEquals("—", loggedOut.amount)
        assertNull(loggedOut.count)
        assertTrue(loggedOut.week.isEmpty())
        assertTrue(loggedOut.recent.isEmpty())
        assertEquals("点击打开应用并登录", loggedOut.sync)
        val waiting = WidgetData.from(null, true, now)
        assertEquals("—", waiting.amount)
        assertNull(waiting.count)
        assertEquals("等待同步，点击刷新", waiting.sync)
        assertEquals("同步后显示饮水记录", waiting.empty)
    }

    @Test fun malformedSnapshotDoesNotBecomeZeroOrCrash() {
        val cache = cache()
        cache.getJSONObject("data").put("date", "invalid").put("timeZone", "invalid")
            .put("totals", JSONObject().put("drinkMl", "NaN").put("drinkCount", -1))
        val data = WidgetData.from(cache, true, now)
        assertEquals("—", data.amount)
        assertNull(data.count)
        assertTrue(data.week.isEmpty())
    }

    @Test fun resizingKeepsRecordsVisibleBeforeTheTrendFits() {
        assertEquals(WidgetSize.SMALL, WidgetSize.forBounds(168, 168))
        assertEquals(WidgetSize.MEDIUM, WidgetSize.forBounds(352, 168))
        assertEquals(WidgetSize.MEDIUM, WidgetSize.forBounds(352, 189))
        assertEquals(WidgetSize.COMPACT, WidgetSize.forBounds(250, 190))
        assertEquals(WidgetSize.COMPACT, WidgetSize.forBounds(352, 220))
        assertEquals(WidgetSize.COMPACT, WidgetSize.forBounds(352, 249))
        assertEquals(WidgetSize.LARGE, WidgetSize.forBounds(250, 250))
        assertEquals(WidgetSize.LARGE, WidgetSize.forBounds(352, 264))
        assertEquals(WidgetSize.LARGE, WidgetSize.forBounds(352, 352))
        assertEquals(WidgetSize.SMALL, WidgetSize.forBounds(168, 500))
        assertEquals(WidgetSize.SMALL, WidgetSize.forBounds(249, 250))
    }
}
