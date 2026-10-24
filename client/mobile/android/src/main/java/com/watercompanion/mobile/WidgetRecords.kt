package com.watercompanion.mobile

import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.util.TypedValue
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import kotlin.math.ceil
import kotlin.math.roundToInt

internal object WidgetRecords {
    @Suppress("DEPRECATION")
    fun bind(context: Context, views: RemoteViews, widgetId: Int, generation: Long, drinks: List<WidgetDrink>, height: Float) {
        val heightPx = (height * context.resources.displayMetrics.density).toInt()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val items = RemoteViews.RemoteCollectionItems.Builder().setViewTypeCount(2)
            rows(context, drinks, heightPx).forEachIndexed { index, row -> items.addItem(index.toLong(), row) }
            views.setRemoteAdapter(R.id.widget_records, items.build())
        } else {
            val intent = Intent(context, WidgetRecordsService::class.java)
                .putExtra("height", heightPx).putExtra("generation", generation)
                .setData(Uri.parse("coaster-widget://records/$widgetId/$heightPx/$generation"))
            views.setRemoteAdapter(R.id.widget_records, intent)
        }
    }

    fun rows(context: Context, drinks: List<WidgetDrink>, height: Int): List<RemoteViews> {
        if (drinks.isEmpty()) return emptyList()
        val metrics = context.resources.displayMetrics
        val font = Paint().apply {
            textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 13f, metrics)
            typeface = Typeface.DEFAULT_BOLD
        }.fontMetrics
        val rowHeight = maxOf((16 * metrics.density).roundToInt(), ceil(font.descent - font.ascent).toInt())
        val rows = drinks.map { drink ->
            RemoteViews(context.packageName, R.layout.widget_record).apply {
                setTextViewText(R.id.widget_record_time, drink.time)
                setTextViewText(R.id.widget_record_amount, drink.amount)
                setOnClickFillInIntent(R.id.widget_record, Intent())
            }
        }
        val end = RemoteViews(context.packageName, R.layout.widget_record_end).apply {
            setInt(R.id.widget_record_end, "setHeight", maxOf((16 * metrics.density).roundToInt(), height - rowHeight * drinks.size))
        }
        return rows + end
    }
}

class WidgetRecordsService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = object : RemoteViewsFactory {
        private val repository = Repository.get(applicationContext)
        private val generation = intent.getLongExtra("generation", -1)
        @Volatile private var rows = emptyList<RemoteViews>()
        private fun current() = repository.status().getLong("generation") == generation
        override fun onCreate() { onDataSetChanged() }
        override fun onDataSetChanged() {
            val data = WidgetData.from(repository.cache(), repository.signedIn())
            rows = if (current()) WidgetRecords.rows(applicationContext, data.recent, intent.getIntExtra("height", 0)) else emptyList()
        }
        override fun onDestroy() { rows = emptyList() }
        override fun getCount() = if (current()) rows.size else 0
        override fun getViewAt(position: Int): RemoteViews? = if (current()) rows.getOrNull(position) else null
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = 2
        override fun getItemId(position: Int) = position.toLong()
        override fun hasStableIds() = false
    }
}
