package xyz.vpavlin.scala.widget

// The widget's list adapter: reads the agenda JSON the app persisted to SharedPreferences and turns
// each entry into a row (color chip + time + title + calendar). Runs in the widget host process;
// onDataSetChanged re-reads the prefs, so a push from ScalaWidgetModule refreshes the list live.
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import org.json.JSONArray
import xyz.vpavlin.scala.R

class ScalaAgendaService : RemoteViewsService() {
  override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = ScalaAgendaFactory(applicationContext)
}

private class ScalaAgendaFactory(private val ctx: Context) : RemoteViewsService.RemoteViewsFactory {
  private var items: JSONArray = JSONArray()

  override fun onCreate() {}
  override fun onDestroy() {}
  override fun getCount(): Int = items.length()
  override fun getViewTypeCount(): Int = 2   // day-divider header + event row
  override fun getItemId(position: Int): Long = position.toLong()
  override fun hasStableIds(): Boolean = false
  override fun getLoadingView(): RemoteViews? = null

  private fun isHeader(position: Int): Boolean =
    items.optJSONObject(position)?.optString("type") == "header"
  override fun getItemViewType(position: Int): Int = if (isHeader(position)) 0 else 1

  // Re-read the pushed agenda JSON. Called on bind and on notifyAppWidgetViewDataChanged.
  override fun onDataSetChanged() {
    val json = ctx.getSharedPreferences(ScalaWidgetModule.PREFS, Context.MODE_PRIVATE)
      .getString(ScalaWidgetModule.KEY_AGENDA, "[]") ?: "[]"
    items = try { JSONArray(json) } catch (e: Exception) { JSONArray() }
  }

  override fun getViewAt(position: Int): RemoteViews {
    val o = items.optJSONObject(position)
    // Day-divider header (Today / Tomorrow / a date).
    if (o?.optString("type") == "header") {
      val rv = RemoteViews(ctx.packageName, R.layout.scala_widget_header)
      rv.setTextViewText(R.id.header_label, o.optString("label", ""))
      rv.setOnClickFillInIntent(R.id.header_root, Intent())
      return rv
    }
    // Event row.
    val rv = RemoteViews(ctx.packageName, R.layout.scala_widget_item)
    if (o == null) return rv
    rv.setTextViewText(R.id.item_time, o.optString("timeLabel", ""))
    rv.setViewVisibility(R.id.item_date, android.view.View.GONE)   // day is shown by the header now
    rv.setTextViewText(R.id.item_title, o.optString("title", "(untitled)"))
    val cal = o.optString("calendar", "")
    rv.setTextViewText(R.id.item_calendar, cal)
    rv.setViewVisibility(R.id.item_calendar, if (cal.isEmpty()) android.view.View.GONE else android.view.View.VISIBLE)
    val color = try { Color.parseColor(o.optString("color", "#89b4fa")) } catch (e: Exception) { Color.parseColor("#89b4fa") }
    rv.setInt(R.id.item_dot, "setColorFilter", color)
    rv.setOnClickFillInIntent(R.id.item_root, Intent())   // tap → open the app
    return rv
  }
}
