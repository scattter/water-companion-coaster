package com.watercompanion.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

class CompanionWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        reconcile(context)
        refresh(context)
    }
    override fun onEnabled(context: Context) { reconcile(context) }
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        render(context, manager, intArrayOf(id))
    }
    override fun onDisabled(context: Context) {
        refreshing.reset()
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        WorkManager.getInstance(context).cancelUniqueWork(ONCE)
    }
    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == REFRESH) refresh(context)
    }
    companion object {
        private const val PERIODIC = "companion-widget-periodic"
        private const val ONCE = "companion-widget-refresh"
        private const val REFRESH = "com.watercompanion.mobile.REFRESH"
        private val refreshing = WidgetRefresh()
        private fun ids(context: Context) = AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, CompanionWidget::class.java))
        fun reconcile(context: Context) {
            renderAll(context)
            val manager = WorkManager.getInstance(context)
            if (!WidgetSchedule.enabled(ids(context).size, Repository.get(context).signedIn())) {
                refreshing.reset()
                manager.cancelUniqueWork(PERIODIC)
                manager.cancelUniqueWork(ONCE)
                return
            }
            manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<WidgetWorker>(WidgetSchedule.MINUTES, TimeUnit.MINUTES)
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
        }
        fun refresh(context: Context) {
            if (!WidgetSchedule.enabled(ids(context).size, Repository.get(context).signedIn())) { renderAll(context); return }
            val request = OneTimeWorkRequestBuilder<WidgetWorker>().build()
            val requestId = request.id.toString()
            if (!refreshing.request(requestId)) return
            renderAll(context)
            fun cancel() { refreshing.cancelRequest(requestId); renderAll(context) }
            try {
                // 手动刷新也要在离线时及时结束，不能等联网约束满足才停止动画。
                val manager = WorkManager.getInstance(context)
                val executor = ContextCompat.getMainExecutor(context)
                val result = manager.enqueueUniqueWork(ONCE, ExistingWorkPolicy.KEEP, request).result
                result.addListener({
                    try {
                        result.get()
                        // KEEP 可能丢弃新请求，必须清理其等待状态，避免按钮一直旋转。
                        val accepted = manager.getWorkInfoById(request.id)
                        accepted.addListener({
                            try { if (accepted.get() == null) cancel() } catch (_: Exception) { cancel() }
                        }, executor)
                    } catch (_: Exception) {
                        cancel()
                    }
                }, executor)
            } catch (_: Exception) {
                cancel()
            }
        }
        internal fun refreshStarted(context: Context, id: String) {
            refreshing.start(id)
            renderAll(context)
        }
        internal fun refreshFinished(context: Context, id: String) {
            refreshing.finish(id)
            renderAll(context)
        }
        fun renderAll(context: Context) {
            render(context, AppWidgetManager.getInstance(context), ids(context))
        }
        private fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            if (ids.isEmpty()) return
            val repository = Repository.get(context)
            val signedIn = repository.signedIn()
            val data = WidgetData.from(repository.cache(), signedIn)
            val progress = refreshing.message().takeIf { signedIn }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val views = RemoteViews(WidgetSize.values().associate { size ->
                    SizeF(size.width.toFloat(), size.height.toFloat()) to layout(context, size, data, progress)
                })
                manager.updateAppWidget(ids, views)
            } else {
                ids.forEach { id ->
                    val options = manager.getAppWidgetOptions(id)
                    // 旧版桌面分别给出横竖屏边界，不能把两个最小值拼成同一个尺寸。
                    val portrait = WidgetSize.forBounds(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250),
                        options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 140))
                    val landscape = WidgetSize.forBounds(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 250),
                        options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 140))
                    manager.updateAppWidget(id, RemoteViews(layout(context, landscape, data, progress), layout(context, portrait, data, progress)))
                }
            }
        }
        private fun layout(context: Context, size: WidgetSize, data: WidgetData, progress: String?): RemoteViews {
            val layout = when (size) {
                WidgetSize.SMALL -> R.layout.companion_widget_small
                WidgetSize.MEDIUM -> R.layout.companion_widget
                WidgetSize.COMPACT, WidgetSize.LARGE -> R.layout.companion_widget_large
            }
            val views = RemoteViews(context.packageName, layout)
            val count = data.count.takeIf { size != WidgetSize.SMALL }
            val title = if (count == null) data.title else "${data.title} $count 次"
            views.setTextViewText(R.id.widget_title, SpannableString(title).apply {
                if (count != null) {
                    val start = data.title.length + 1
                    val end = start + count.toString().length
                    setSpan(ForegroundColorSpan(context.getColor(R.color.widget_accent)), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    setSpan(RelativeSizeSpan(1.18f), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            })
            views.setTextViewText(R.id.widget_amount, SpannableString("${data.amount} ml").apply {
                setSpan(RelativeSizeSpan(0.45f), length - 2, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            })
            views.setTextViewText(R.id.widget_sync, progress ?: data.sync)
            views.setViewVisibility(R.id.widget_refresh_icon, if (progress == null) View.VISIBLE else View.GONE)
            views.setViewVisibility(R.id.widget_refresh_progress, if (progress == null) View.GONE else View.VISIBLE)
            views.setContentDescription(R.id.widget_refresh, progress ?: "刷新饮水数据")
            if (size == WidgetSize.MEDIUM) {
                views.setTextViewText(R.id.widget_recent, data.recent.firstOrNull()?.let { "最近 ${it.time} · ${it.amount}" } ?: data.empty)
            }
            if (size == WidgetSize.COMPACT || size == WidgetSize.LARGE) {
                views.setTextViewText(R.id.widget_date, data.date)
                views.setViewVisibility(R.id.widget_trend, if (size == WidgetSize.LARGE) View.VISIBLE else View.GONE)
                views.setViewVisibility(R.id.widget_chart, if (data.week.isEmpty()) View.GONE else View.VISIBLE)
                views.setViewVisibility(R.id.widget_chart_empty, if (data.week.isEmpty()) View.VISIBLE else View.GONE)
                if (data.week.isNotEmpty()) {
                    views.setImageViewBitmap(R.id.widget_chart, chart(context, data.week))
                    views.setContentDescription(R.id.widget_chart, data.week.joinToString("，") {
                        "${it.date}：${it.amount?.let { value -> "${WidgetData.amount(value)} 毫升" } ?: "暂无数据"}"
                    })
                }
                listOf(
                    Triple(R.id.widget_record_first, R.id.widget_time_first, R.id.widget_amount_first),
                    Triple(R.id.widget_record_second, R.id.widget_time_second, R.id.widget_amount_second),
                ).forEachIndexed { index, (row, time, amount) ->
                    val drink = data.recent.getOrNull(index)
                    views.setViewVisibility(row, if (drink == null) View.GONE else View.VISIBLE)
                    if (drink != null) {
                        views.setTextViewText(time, drink.time)
                        views.setTextViewText(amount, drink.amount)
                    }
                }
                views.setViewVisibility(R.id.widget_records_empty, if (data.recent.isEmpty()) View.VISIBLE else View.GONE)
                views.setTextViewText(R.id.widget_records_empty, data.empty)
            }
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                val open = PendingIntent.getActivity(context, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                views.setOnClickPendingIntent(R.id.widget_root, open)
                if (size == WidgetSize.COMPACT || size == WidgetSize.LARGE) views.setOnClickPendingIntent(R.id.widget_open, open)
            }
            views.setOnClickPendingIntent(R.id.widget_refresh, PendingIntent.getBroadcast(context, 2,
                Intent(context, CompanionWidget::class.java).setAction(REFRESH), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            return views
        }
        private fun chart(context: Context, week: List<WidgetDay>): Bitmap {
            val bitmap = Bitmap.createBitmap(630, 120, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val maximum = week.mapNotNull { it.amount }.maxOrNull()?.coerceAtLeast(1.0) ?: 1.0
            week.forEachIndexed { index, day ->
                val center = index * 90f + 45f
                paint.color = context.getColor(if (index == week.lastIndex) R.color.widget_accent else R.color.widget_bar)
                day.amount?.let { amount ->
                    val height = (amount / maximum * 76).toFloat().coerceAtLeast(2f)
                    canvas.drawRoundRect(center - 23f, 80f - height, center + 23f, 80f, 5f, 5f, paint)
                }
                paint.color = context.getColor(R.color.widget_muted)
                paint.textSize = 28f
                paint.textAlign = Paint.Align.CENTER
                paint.typeface = if (index == week.lastIndex) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                canvas.drawText("${day.date.monthValue}/${day.date.dayOfMonth}", center, 112f, paint)
                if (day.amount == null) canvas.drawText("—", center, 70f, paint)
            }
            return bitmap
        }
        fun pin(context: Context): Boolean {
            val manager = AppWidgetManager.getInstance(context)
            return manager.isRequestPinAppWidgetSupported && manager.requestPinAppWidget(ComponentName(context, CompanionWidget::class.java), null, null)
        }
    }
}
class WidgetWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val startedAt = SystemClock.elapsedRealtime()
        try {
            CompanionWidget.refreshStarted(applicationContext, id.toString())
            withContext(Dispatchers.IO) { Repository.get(applicationContext).sync() }
            return Result.success()
        } finally {
            // 快速返回也保留可见反馈；取消和失败同样恢复按钮。
            withContext(NonCancellable) {
                delay((600L - (SystemClock.elapsedRealtime() - startedAt)).coerceAtLeast(0L))
                CompanionWidget.refreshFinished(applicationContext, id.toString())
            }
        }
    }
}
