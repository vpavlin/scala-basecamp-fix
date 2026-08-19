package xyz.vpavlin.scala.widget

// RN bridge that feeds the home-screen agenda widget. The JS side (src/lib/widget.ts) computes the
// next N upcoming events from the SAME agenda fold the in-app Agenda view uses, and pushes them here
// as a JSON array. We persist that JSON to SharedPreferences (the widget process reads it) and poke
// every live widget instance to reload its list. No delivery/node involved — this is purely local,
// so the widget works offline exactly like the app.
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class ScalaWidgetModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "ScalaWidget"

  companion object {
    const val PREFS = "scala_widget"
    const val KEY_AGENDA = "agenda_json"     // JSON array of {title,timeLabel,dateLabel,calendar,color}
    const val KEY_UPDATED = "updated_ms"
  }

  // Persist the agenda JSON and refresh every widget instance's list.
  @ReactMethod
  fun updateAgenda(json: String, promise: Promise) {
    try {
      ctx.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).edit()
        .putString(KEY_AGENDA, json)
        .putLong(KEY_UPDATED, System.currentTimeMillis())
        .apply()
      val mgr = AppWidgetManager.getInstance(ctx)
      val ids = mgr.getAppWidgetIds(ComponentName(ctx, ScalaAgendaWidget::class.java))
      // Rebind the whole widget (header + list) and tell the collection to re-read its data.
      ScalaAgendaWidget.updateAll(ctx, mgr, ids)
      mgr.notifyAppWidgetViewDataChanged(ids, xyz.vpavlin.scala.R.id.scala_widget_list)
      promise.resolve(ids.size)
    } catch (e: Exception) {
      promise.reject("widget_update_fail", e.message, e)
    }
  }
}
