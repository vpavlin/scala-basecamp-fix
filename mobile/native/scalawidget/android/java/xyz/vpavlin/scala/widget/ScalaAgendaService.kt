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
  override fun getViewTypeCount(): Int = 1
  override fun getItemId(position: Int): Long = position.toLong()
  override fun hasStableIds(): Boolean = false
  override fun getLoadingView(): RemoteViews? = null

  // Re-read the pushed agenda JSON. Called on bind and on notifyAppWidgetViewDataChanged.
  override fun onDataSetChanged() {
    val json = ctx.getSharedPreferences(ScalaWidgetModule.PREFS, Context.MODE_PRIVATE)
      .getString(ScalaWidgetModule.KEY_AGENDA, "[]") ?: "[]"
    items = try { JSONArray(json) } catch (e: Exception) { JSONArray() }
  }

  override fun getViewAt(position: Int): RemoteViews {
    val rv = RemoteViews(ctx.packageName, R.layout.scala_widget_item)
    val o = items.optJSONObject(position) ?: return rv
    rv.setTextViewText(R.id.item_time, o.optString("timeLabel", ""))
    rv.setTextViewText(R.id.item_date, o.optString("dateLabel", ""))
    rv.setTextViewText(R.id.item_title, o.optString("title", "(untitled)"))
    val cal = o.optString("calendar", "")
    rv.setTextViewText(R.id.item_calendar, cal)
    rv.setViewVisibility(R.id.item_calendar, if (cal.isEmpty()) android.view.View.GONE else android.view.View.VISIBLE)
    val color = try { Color.parseColor(o.optString("color", "#89b4fa")) } catch (e: Exception) { Color.parseColor("#89b4fa") }
    rv.setInt(R.id.item_dot, "setColorFilter", color)
    // Row tap → open the app (fill-in for the header's pending-intent template).
    rv.setOnClickFillInIntent(R.id.item_root, Intent())
    return rv
  }
}
