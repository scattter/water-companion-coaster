package com.watercompanion.mobile

internal class WidgetRefresh {
    private var pending: String? = null
    private val running = mutableSetOf<String>()

    @Synchronized fun request(id: String): Boolean {
        if (pending != null || running.isNotEmpty()) return false
        pending = id
        return true
    }
    @Synchronized fun start(id: String) { if (pending == id) pending = null; running.add(id) }
    @Synchronized fun finish(id: String) { running.remove(id) }
    @Synchronized fun cancelRequest(id: String) { if (pending == id) pending = null }
    @Synchronized fun reset() { pending = null; running.clear() }
    @Synchronized fun message(): String? = when {
        running.isNotEmpty() -> "正在刷新…"
        pending != null -> "等待刷新…"
        else -> null
    }
}
