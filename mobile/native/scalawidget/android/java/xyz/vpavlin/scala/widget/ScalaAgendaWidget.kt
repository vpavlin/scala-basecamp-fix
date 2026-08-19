package xyz.vpavlin.scala.widget

// Home-screen agenda widget: a header (Scala + today's date) over a scrolling list of upcoming
// events, backed by ScalaAgendaService which reads the JSON the app pushed to SharedPreferences.
// Tapping anywhere opens the app. Data is local-only, so the widget is populated offline too.
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import xyz.vpavlin.scala.R

class ScalaAgendaWidget : AppWidgetProvider() {
  override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) = updateAll(ctx, mgr, ids)

  companion object {
    fun updateAll(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
      for (id in ids) mgr.updateAppWidget(id, build(ctx, id))
    }

    private fun openAppIntent(ctx: Context): Intent =
      ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        ?: Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)

    private fun build(ctx: Context, widgetId: Int): RemoteViews {
      val rv = RemoteViews(ctx.packageName, R.layout.scala_widget)
      rv.setTextViewText(R.id.scala_widget_title, "Scala")
      rv.setTextViewText(R.id.scala_widget_date, SimpleDateFormat("EEE d MMM", Locale.getDefault()).format(Date()))

      // Bind the collection to the RemoteViewsService (embed the widget id so instances are distinct).
      val svc = Intent(ctx, ScalaAgendaService::class.java).apply {
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
        data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
      }
      rv.setRemoteAdapter(R.id.scala_widget_list, svc)
      rv.setEmptyView(R.id.scala_widget_list, R.id.scala_widget_empty)

      // Tap the header → open the app; tap a row → open the app (empty fill-in intent).
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or
        (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
      rv.setOnClickPendingIntent(R.id.scala_widget_header,
        PendingIntent.getActivity(ctx, 0, openAppIntent(ctx), flags))
      val templateFlags = PendingIntent.FLAG_UPDATE_CURRENT or
        (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
      rv.setPendingIntentTemplate(R.id.scala_widget_list,
        PendingIntent.getActivity(ctx, 1, openAppIntent(ctx), templateFlags))
      return rv
    }
  }

  // A fresh install has no data yet — nothing to do; the app pushes on first render.
  override fun onEnabled(ctx: Context) {}
  override fun onDisabled(ctx: Context) {}
}
