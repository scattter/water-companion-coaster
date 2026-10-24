package com.watercompanion.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.SpannableString
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.util.SizeF
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

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
        private var petBitmap: Bitmap? = null
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
        @Suppress("DEPRECATION")
        private fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            if (ids.isEmpty()) return
            val repository = Repository.get(context)
            val generation = repository.status().getLong("generation")
            val signedIn = repository.signedIn()
            val data = WidgetData.from(repository.cache(), signedIn)
            val progress = refreshing.message().takeIf { signedIn }
            ids.forEach { id ->
                val options = manager.getAppWidgetOptions(id)
                // 横竖屏边界需要成对使用；真实高度也用于记录尾部留白和小卡片居中。
                val portrait = SizeF(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250).toFloat(),
                    options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 140).toFloat())
                val landscape = SizeF(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 250).toFloat(),
                    options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 140).toFloat())
                fun view(bounds: SizeF) = layout(context, bounds, data, progress, id, generation)
                val views = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val sizes = options.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES)
                        ?.takeIf { it.isNotEmpty() } ?: listOf(portrait, landscape)
                    RemoteViews(sizes.associateWith(::view))
                } else {
                    RemoteViews(view(landscape), view(portrait))
                }
                if (repository.status().getLong("generation") != generation) return
                manager.updateAppWidget(id, views)
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) manager.notifyAppWidgetViewDataChanged(id, R.id.widget_records)
            }
        }
        private fun layout(context: Context, bounds: SizeF, data: WidgetData, progress: String?, id: Int, generation: Long): RemoteViews {
            val size = WidgetSize.forBounds(bounds.width.roundToInt(), bounds.height.roundToInt())
            val layout = when (size) {
                WidgetSize.SMALL -> R.layout.companion_widget_small
                WidgetSize.MEDIUM -> R.layout.companion_widget
                WidgetSize.COMPACT, WidgetSize.LARGE -> R.layout.companion_widget_large
            }
            val views = RemoteViews(context.packageName, layout)
            val count = data.count.takeIf { size != WidgetSize.SMALL }
            val title = if (count == null) data.title else "${data.title} $count 次"
            val titleText = SpannableString(title).apply {
                if (count != null) {
                    val start = data.title.length + 1
                    val end = start + count.toString().length
                    setSpan(ForegroundColorSpan(context.getColor(R.color.widget_accent)), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    setSpan(RelativeSizeSpan(1.18f), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
            views.setTextViewText(R.id.widget_title, titleText)
            views.setTextViewText(R.id.widget_amount, SpannableString("${data.amount} ml").apply {
                setSpan(RelativeSizeSpan(0.45f), length - 2, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            })
            views.setTextViewText(R.id.widget_sync, progress ?: data.sync)
            views.setViewVisibility(R.id.widget_refresh_icon, if (progress == null) View.VISIBLE else View.GONE)
            views.setViewVisibility(R.id.widget_refresh_progress, if (progress == null) View.GONE else View.VISIBLE)
            views.setContentDescription(R.id.widget_refresh, progress ?: "刷新饮水数据")
            if (size == WidgetSize.SMALL) {
                val density = context.resources.displayMetrics.density
                // 高度足够时给图案上下相同的空间；最小卡片仍为标题和同步文字留出位置。
                val bottom = if (bounds.height - 24 - 128 >= 32) 64 else 24
                views.setViewPadding(R.id.widget_pet, 0, (64 * density).roundToInt(), 0, (bottom * density).roundToInt())
                views.setImageViewBitmap(R.id.widget_pet, pet(context))
            }
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
                // 旧快照日期或大字体可能使标题换行，尾注需要扣除统计区增加的高度。
                val metrics = context.resources.displayMetrics
                val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                    textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 12f, metrics)
                    typeface = Typeface.create("sans-serif", Typeface.NORMAL)
                }
                val titleWidth = ((bounds.width - 28) * metrics.density * 1.1f / 2.1f).toInt().coerceAtLeast(1)
                val titleHeight = StaticLayout.Builder.obtain(titleText, 0, titleText.length, titlePaint, titleWidth)
                    .setIncludePad(false).setMaxLines(2).build().height / metrics.density
                val summaryExtra = (titleHeight + 4 + 34 - 56).coerceAtLeast(0f)
                val recordHeight = if (size == WidgetSize.COMPACT) bounds.height - 157 - summaryExtra else 32 + (bounds.height - 245 - summaryExtra) / 3
                WidgetRecords.bind(context, views, id, generation, data.recent, recordHeight)
                views.setEmptyView(R.id.widget_records, R.id.widget_records_empty)
                views.setViewVisibility(R.id.widget_records, if (data.recent.isEmpty()) View.GONE else View.VISIBLE)
                views.setViewVisibility(R.id.widget_records_empty, if (data.recent.isEmpty()) View.VISIBLE else View.GONE)
                views.setTextViewText(R.id.widget_records_empty, data.empty)
            }
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                val open = PendingIntent.getActivity(context, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                views.setOnClickPendingIntent(R.id.widget_root, open)
                if (size == WidgetSize.COMPACT || size == WidgetSize.LARGE) {
                    views.setOnClickPendingIntent(R.id.widget_open, open)
                    val template = PendingIntent.getActivity(context, 3, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                    views.setPendingIntentTemplate(R.id.widget_records, template)
                }
            }
            views.setOnClickPendingIntent(R.id.widget_refresh, PendingIntent.getBroadcast(context, 2,
                Intent(context, CompanionWidget::class.java).setAction(REFRESH), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            return views
        }
        private fun pet(context: Context): Bitmap = synchronized(this) {
            petBitmap ?: run {
                val source = BitmapFactory.decodeResource(context.resources, R.drawable.water_cap, BitmapFactory.Options().apply { inScaled = false })
                val pixels = IntArray(source.width * source.height)
                source.getPixels(pixels, 0, source.width, 0, 0, source.width, source.height)
                var left = source.width
                var top = source.height
                var right = 0
                var bottom = 0
                pixels.forEachIndexed { index, pixel ->
                    if (pixel ushr 24 != 0) {
                        val x = index % source.width
                        val y = index / source.width
                        left = minOf(left, x); right = maxOf(right, x)
                        top = minOf(top, y); bottom = maxOf(bottom, y)
                    }
                }
                // 素材透明边缘不对称，按可见图案居中，避免只居中图片画布。
                (if (left <= right && top <= bottom) Bitmap.createBitmap(source, left, top, right - left + 1, bottom - top + 1) else source)
                    .also { petBitmap = it }
            }
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
