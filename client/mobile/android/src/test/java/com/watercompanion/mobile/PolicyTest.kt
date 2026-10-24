package com.watercompanion.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class PolicyTest {
    @Test fun restrictsRequestsToExistingUserEndpoints() {
        assertTrue(Policy.allowed("/api/dashboard?date=2026-10-23", false))
        assertTrue(Policy.allowed("/api/enrollment/operations/abc-123", false))
        assertTrue(Policy.allowed("/api/control/cup", true))
        for (path in listOf("https://other.invalid/api/dashboard", "/api/../admin/settings", "/api/admin/settings", "/api/device/heartbeat", "/api/dashboard?date=2026-10-23&next=https://other.invalid")) {
            assertFalse(path, Policy.allowed(path, false))
            assertFalse(path, Policy.allowed(path, true))
        }
    }
    @Test fun cookiesCannotInjectHeadersOrUseSecureCookiesOverHttp() {
        val token = "a1".repeat(32)
        assertEquals(token, Policy.token(listOf("coaster_session=$token; Secure; HttpOnly"), true))
        assertNull(Policy.token(listOf("coaster_session=$token; Secure"), false))
        assertNull(Policy.token(listOf("coaster_session=$token", "coaster_session=invalid"), true))
        assertNull(Policy.token(listOf("coaster_session=invalid\r\nInjected: value"), true))
    }
    @Test fun originsCannotChangeDestinationUsingPathsOrCredentials() {
        assertEquals("https://water.example:8443", Policy.origin("https://water.example:8443/"))
        for (address in listOf("https://user@water.example", "https://water.example/api", "https://water.example/%2f", "https://water.example/?x=1", "file:///tmp")) {
            assertThrows(IllegalArgumentException::class.java) { Policy.origin(address) }
        }
    }
    @Test fun widgetDoesNotReplaceTodayWithSelectedHistoryAndUsesServerTimezone() {
        val now = Instant.parse("2026-10-22T17:00:00Z")
        val data = JSONObject().put("timeZone", "Asia/Shanghai").put("date", "2026-10-23")
        assertTrue(Policy.currentDay(data, now))
        assertFalse(Policy.currentDay(data.put("date", "2026-10-22"), now))
        assertFalse(Policy.currentDay(data.put("timeZone", "invalid"), now))
    }
}
