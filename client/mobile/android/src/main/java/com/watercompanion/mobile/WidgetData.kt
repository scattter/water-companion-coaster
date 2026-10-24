package com.watercompanion.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

internal enum class WidgetSize(val width: Int, val height: Int) {
    // 桌面格数没有固定的 dp 尺寸，较矮的卡片优先保留记录，再增加趋势。
    SMALL(120, 140), MEDIUM(250, 140), COMPACT(250, 190), LARGE(250, 250);

    companion object {
        fun forBounds(width: Int, height: Int): WidgetSize = when {
            width >= LARGE.width && height >= LARGE.height -> LARGE
            width >= COMPACT.width && height >= COMPACT.height -> COMPACT
            width >= MEDIUM.width -> MEDIUM
            else -> SMALL
        }
    }
}

internal data class WidgetDrink(val time: String, val amount: String)
internal data class WidgetDay(val date: LocalDate, val amount: Double?)
internal data class WidgetData(
    val title: String,
    val date: String,
    val amount: String,
    val count: Int?,
    val sync: String,
    val recent: List<WidgetDrink>,
    val week: List<WidgetDay>,
    val empty: String,
) {
    companion object {
        fun amount(value: Double): String = NumberFormat.getNumberInstance(Locale.CHINA).apply {
            maximumFractionDigits = 1
        }.format(value)

        fun from(cache: JSONObject?, signedIn: Boolean, now: Instant = Instant.now()): WidgetData {
            val data = cache?.optJSONObject("data").takeIf { signedIn }
            val date = data?.optString("date")?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
            val zone = runCatching { ZoneId.of(data?.optString("timeZone")) }.getOrDefault(ZoneId.systemDefault())
            val current = date != null && Policy.currentDay(data!!, now)
            val number = data?.optJSONObject("totals")?.number("drinkMl")
            val count = data?.optJSONObject("totals")?.optInt("drinkCount", -1)?.takeIf { it >= 0 }
            val syncedAt = cache?.optLong("syncedAt", 0)?.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it) }
            val sync = when {
                !signedIn -> "点击打开应用并登录"
                data == null || syncedAt == null -> "等待同步，点击刷新"
                else -> {
                    // 系统可能延后跨日刷新，始终标出同步日期以便辨认旧快照。
                    val time = DateTimeFormatter.ofPattern("M/d HH:mm").withZone(zone).format(syncedAt)
                    "${if (cache?.optBoolean("offline") == true) "离线 · " else ""}$time 同步"
                }
            }
            val recent = data?.optJSONArray("events").objects().mapNotNull { event ->
                if (event.optString("kind") != "drink" || !event.isNull("revokedAt")) return@mapNotNull null
                val value = event.number("amountMl") ?: return@mapNotNull null
                val time = runCatching { Instant.parse(event.optString("occurredAt")) }.getOrNull() ?: return@mapNotNull null
                if (time.atZone(zone).toLocalDate() != date) return@mapNotNull null
                time to WidgetDrink(DateTimeFormatter.ofPattern("HH:mm").withZone(zone).format(time), "${amount(value)} ml")
            }.sortedByDescending { it.first }.take(2).map { it.second }
            val history = data?.optJSONArray("week").objects().associate { it.optString("date") to it.number("drinkMl") }
            val week = date?.let { end -> (6L downTo 0L).map { offset ->
                val day = end.minusDays(offset)
                WidgetDay(day, if (day == end) number else history[day.toString()])
            } } ?: emptyList()
            return WidgetData(
                title = if (date == null || current) "今日饮水" else "$date 饮水",
                date = date?.format(DateTimeFormatter.ofPattern("M月d日 E", Locale.CHINA)) ?: "饮水小记",
                amount = number?.let(::amount) ?: "—",
                count = count,
                sync = sync,
                recent = recent,
                week = week,
                empty = when {
                    !signedIn -> "登录后查看饮水记录"
                    data == null -> "同步后显示饮水记录"
                    current -> "今日暂无饮水记录"
                    else -> "该日暂无饮水记录"
                },
            )
        }

        private fun JSONObject.number(key: String) = optDouble(key).takeIf { it.isFinite() && it >= 0 }
        private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else
            (0 until length()).mapNotNull { optJSONObject(it) }
    }
}
