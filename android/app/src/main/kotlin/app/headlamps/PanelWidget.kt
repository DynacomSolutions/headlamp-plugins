package app.headlamps

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

private val P_SMALL = DpSize(110.dp, 110.dp)
private val P_TALL = DpSize(110.dp, 180.dp)
private val P_MEDIUM = DpSize(170.dp, 110.dp)
private val P_WIDE = DpSize(250.dp, 180.dp)
private val P_CHART = DpSize(250.dp, 260.dp)

private val OK_COLOUR = Color(0xFF2E7D32)
private val WARN_COLOUR = Color(0xFFF9A825)
private val CRIT_COLOUR = Color(0xFFC62828)
private val UNKNOWN_COLOUR = Color(0xFF757575)

private fun argbOf(status: PanelStatus): Color = when (status) {
    PanelStatus.OK -> OK_COLOUR
    PanelStatus.WARN -> WARN_COLOUR
    PanelStatus.CRIT -> CRIT_COLOUR
    PanelStatus.UNKNOWN -> UNKNOWN_COLOUR
}

private fun statusColour(status: PanelStatus): ColorProvider = ColorProvider(argbOf(status))

class PanelWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(P_SMALL, P_MEDIUM, P_TALL, P_WIDE, P_CHART))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val repository = Repository(context)
        val widgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val flow = repository.panelState(widgetId)
        val first = flow.first()
        provideContent {
            // Read inside the composition, so that new data recomposes the widget.
            val state by flow.collectAsState(initial = first)
            GlanceTheme { PanelBody(widgetId, state) }
        }
    }
}

@Composable
private fun PanelBody(widgetId: Int, state: PanelWidgetState) {
    val context = LocalContext.current
    val size = LocalSize.current
    val tall = size.height >= P_TALL.height
    val wide = size.width >= P_WIDE.width
    val chart = size.width >= P_CHART.width && size.height >= P_CHART.height
    val config = state.config
    val snapshot = state.snapshot
    val model = snapshot?.model
    val base = state.instance?.baseUrl
    val open = if (config != null && base != null) {
        GlanceModifier.clickable(
            actionStartActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(panelLinkUrl(base, config.cluster, model?.link))),
            ),
        )
    } else {
        GlanceModifier
    }
    val configure = GlanceModifier.clickable(
        actionStartActivity(
            Intent(context, PanelConfigActivity::class.java)
                .setData(Uri.parse("headlamps://panel-configure/$widgetId"))
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId),
        ),
    )
    Column(
        modifier = GlanceModifier.fillMaxSize()
            .background(GlanceTheme.colors.widgetBackground)
            .cornerRadius(16.dp)
            .padding(8.dp),
    ) {
        PanelHeader(model, snapshot, wide)
        Spacer(GlanceModifier.height(4.dp))
        when {
            config == null -> PanelMessage(context.getString(R.string.widget_choose), configure)
            snapshot == null -> PanelMessage(context.getString(R.string.widget_loading), open)
            snapshot.error != null -> PanelMessage(errorMessage(context, snapshot), open)
            model == null -> PanelMessage(context.getString(R.string.widget_no_nodes), open)
            else -> {
                val stats = model.stats.take(if (wide) 4 else if (size.width >= 160.dp) 3 else 2)
                PanelStats(stats, open)
                if (tall && model.rows.isNotEmpty()) {
                    Spacer(GlanceModifier.height(6.dp))
                    if (chart) PanelChart(model)
                    PanelRows(model, base, config, wide)
                }
            }
        }
    }
}

private fun errorMessage(context: Context, snapshot: PanelSnapshot): String {
    val text = context.getString(panelErrorText(snapshot.error))
    return if (snapshot.error == ErrorKind.PANEL_FAILED && !snapshot.detail.isNullOrBlank()) "$text ${snapshot.detail}" else text
}

fun panelErrorText(kind: ErrorKind?): Int = errorText(kind)

@Composable
private fun PanelHeader(model: PanelModel?, snapshot: PanelSnapshot?, wide: Boolean) {
    val context = LocalContext.current
    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (model != null) {
            Box(modifier = GlanceModifier.width(4.dp).height(26.dp).background(statusColour(model.status))) {}
            Spacer(GlanceModifier.width(6.dp))
        }
        Column(modifier = GlanceModifier.defaultWeight()) {
            Text(
                model?.title?.ifBlank { null } ?: context.getString(R.string.panel_widget_name),
                maxLines = 1,
                style = TextStyle(color = GlanceTheme.colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 13.sp),
            )
            if (snapshot != null && wide) {
                Text(
                    context.getString(R.string.widget_updated, DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(snapshot.updatedAt))),
                    maxLines = 1,
                    style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp),
                )
            }
        }
        Text(
            context.getString(R.string.widget_refresh),
            modifier = GlanceModifier.clickable(actionRunCallback<RefreshAction>()).padding(4.dp),
            style = TextStyle(color = GlanceTheme.colors.primary, fontWeight = FontWeight.Medium, fontSize = 12.sp),
        )
    }
}

@Composable
private fun PanelMessage(text: String, modifier: GlanceModifier) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.sp))
    }
}

@Composable
private fun PanelStats(stats: List<PanelStat>, modifier: GlanceModifier) {
    if (stats.isEmpty()) return
    Row(modifier = modifier.fillMaxWidth()) {
        stats.forEach { stat ->
            Column(modifier = GlanceModifier.defaultWeight()) {
                Text(
                    stat.value,
                    maxLines = 1,
                    style = TextStyle(color = statusColour(stat.status), fontWeight = FontWeight.Bold, fontSize = 16.sp),
                )
                Text(
                    stat.label,
                    maxLines = 1,
                    style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp),
                )
            }
        }
    }
}

@Composable
private fun PanelChart(model: PanelModel) {
    val series = model.series.firstOrNull { it.points.size >= 2 } ?: return
    val bitmap = renderSparkline(series.points, argbOf(model.status).toArgbInt()) ?: return
    Column(modifier = GlanceModifier.fillMaxWidth().padding(bottom = 6.dp)) {
        Text(series.label, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp))
        Image(
            provider = ImageProvider(bitmap),
            contentDescription = series.label,
            contentScale = ContentScale.FillBounds,
            modifier = GlanceModifier.fillMaxWidth().height(40.dp),
        )
    }
}

private fun Color.toArgbInt(): Int = this.toArgb()

@Composable
private fun PanelRows(model: PanelModel, base: String?, config: PanelConfig, wide: Boolean) {
    val rows = sortPanelRows(model.rows)
    LazyColumn(modifier = GlanceModifier.fillMaxSize()) {
        items(rows) { row ->
            val open = if (base != null) {
                GlanceModifier.clickable(
                    actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(panelLinkUrl(base, config.cluster, rowLink(row, model))))),
                )
            } else {
                GlanceModifier
            }
            Column(modifier = open.fillMaxWidth().padding(vertical = 3.dp)) {
                Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = GlanceModifier.defaultWeight()) {
                        Text(row.label, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.sp))
                        if (wide && row.detail.isNotBlank()) {
                            Text(row.detail, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp))
                        }
                    }
                    if (row.value.isNotBlank()) {
                        Text(
                            row.value,
                            maxLines = 1,
                            modifier = GlanceModifier.padding(start = 4.dp),
                            style = TextStyle(color = statusColour(row.status), fontWeight = FontWeight.Medium, fontSize = 12.sp, textAlign = TextAlign.End),
                        )
                    }
                }
                row.fraction?.let {
                    LinearProgressIndicator(
                        progress = barFraction(it * 100.0),
                        modifier = GlanceModifier.fillMaxWidth().height(4.dp),
                        color = statusColour(row.status),
                        backgroundColor = GlanceTheme.colors.surfaceVariant,
                    )
                }
            }
        }
    }
}

class PanelWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PanelWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        RefreshWorker.schedulePeriodic(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        RefreshWorker.cancelPeriodicIfIdle(context)
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        val pending = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                val repository = Repository(context)
                appWidgetIds.forEach { repository.removePanelWidget(it) }
            } finally {
                pending.finish()
            }
        }
    }
}
