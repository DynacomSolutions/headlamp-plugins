package app.headlamps

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.AndroidRemoteViews
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import kotlinx.coroutines.flow.first
import java.text.DateFormat
import java.util.Date
import androidx.glance.color.ColorProvider as DayNightColour

/** CPU and memory use as rings. The ring size follows the exact widget size, so the bitmaps stay sharp. */
class UsageDashboardWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val repository = Repository(context)
        val widgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val flow = repository.ringsState(widgetId)
        val first = flow.first()
        provideContent {
            // Read inside the composition, so that new data recomposes the widget.
            val state by flow.collectAsState(initial = first)
            GlanceTheme { UsageBody(widgetId, state) }
        }
    }
}

@Composable
private fun UsageBody(widgetId: Int, state: RingsWidgetState) {
    val context = LocalContext.current
    val size = LocalSize.current
    val config = state.config
    val snapshot = state.snapshot
    val model = snapshot?.model
    val cpu = model?.rings?.firstOrNull { it.id == "cpu" }
    val memory = model?.rings?.firstOrNull { it.id == "memory" }
    val layout = usageLayout(size.width.value.toDouble(), size.height.value.toDouble(), twoRings = cpu != null && memory != null)
    val base = state.instance?.baseUrl
    val open = if (config != null && base != null) {
        GlanceModifier.clickable(actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(usagePageUrl(base, config.cluster)))))
    } else {
        GlanceModifier
    }
    val configure = GlanceModifier.clickable(
        actionStartActivity(
            Intent(context, UsageDashboardConfigActivity::class.java)
                .setData(Uri.parse("headlamps://usage-configure/$widgetId"))
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId),
        ),
    )
    Column(
        modifier = GlanceModifier.fillMaxSize()
            .background(GlanceTheme.colors.widgetBackground)
            .cornerRadius(16.dp)
            .padding(USAGE_PADDING_DP.dp),
    ) {
        UsageHeader(config?.cluster.orEmpty(), snapshot, layout)
        Spacer(GlanceModifier.height(4.dp))
        when {
            config == null -> UsageMessage(context.getString(R.string.widget_choose), configure)
            snapshot == null -> UsageMessage(context.getString(R.string.widget_loading), open)
            snapshot.error != null -> UsageMessage(usageErrorMessage(context, snapshot), open)
            cpu == null && memory == null -> UsageMessage(context.getString(R.string.usage_no_data), open)
            else -> Box(modifier = open.fillMaxSize()) { UsageRings(cpu, memory, layout, open) }
        }
    }
}

private fun usageErrorMessage(context: Context, snapshot: PanelSnapshot): String {
    if (snapshot.error == ErrorKind.NOT_FOUND) return context.getString(R.string.error_usage_panel_missing)
    val text = context.getString(errorText(snapshot.error))
    return if (snapshot.error == ErrorKind.PANEL_FAILED && !snapshot.detail.isNullOrBlank()) "$text ${snapshot.detail}" else text
}

@Composable
private fun UsageHeader(cluster: String, snapshot: PanelSnapshot?, layout: UsageLayout) {
    val context = LocalContext.current
    Row(modifier = GlanceModifier.fillMaxWidth().height(layout.headerDp.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = GlanceModifier.defaultWeight()) {
            Text(
                cluster.ifBlank { context.getString(R.string.usage_widget_name) },
                maxLines = 1,
                style = TextStyle(color = GlanceTheme.colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 13.sp),
            )
            if (snapshot != null && layout.showUpdated) {
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
private fun UsageMessage(text: String, modifier: GlanceModifier) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.sp))
    }
}

@Composable
private fun UsageRings(cpu: PanelRing?, memory: PanelRing?, layout: UsageLayout, open: GlanceModifier) {
    val context = LocalContext.current
    val cpuLabel = context.getString(R.string.label_cpu)
    val memLabel = context.getString(R.string.label_memory)
    val d = layout.diameterDp
    val half = layout.halfWidthDp.dp
    val gap = USAGE_GAP_DP.dp
    if (cpu == null || memory == null) {
        val only = cpu ?: memory ?: return
        Row(modifier = GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalAlignment = Alignment.CenterHorizontally) {
            RingView(only, if (only.id == "cpu") cpuLabel else memLabel, d)
        }
        return
    }
    when (layout.kind) {
        UsageKind.SIDE_LEGEND_BELOW -> {
            val entries = remember(cpu, memory) { combinedLegend(cpu, memory) }
            Column(modifier = GlanceModifier.fillMaxSize()) {
                Row(modifier = GlanceModifier.fillMaxWidth()) {
                    RingWithCaption(cpu, cpuLabel, d, half)
                    Spacer(GlanceModifier.width(gap))
                    RingWithCaption(memory, memLabel, d, half)
                }
                Spacer(GlanceModifier.height(2.dp))
                LegendHeader(layout.contentWidthDp.dp, cpuLabel, memLabel)
                LazyColumn(modifier = GlanceModifier.fillMaxWidth().height((layout.legendRows * LEGEND_ROW_DP).dp)) {
                    items(entries.size) { index ->
                        Box(modifier = open.fillMaxWidth().height(LEGEND_ROW_DP.dp)) {
                            LegendRow(entries[index], layout.contentWidthDp.dp, true)
                        }
                    }
                }
            }
        }
        UsageKind.SIDE_LEGEND_BESIDE, UsageKind.SIDE_KEY_BESIDE -> {
            val values = layout.kind == UsageKind.SIDE_LEGEND_BESIDE
            val legendWidth = layout.legendWidthDp.dp
            val entries = remember(cpu, memory, layout.legendRows) { combinedLegend(cpu, memory).take(layout.legendRows) }
            Row(modifier = GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
                RingView(cpu, cpuLabel, d)
                Spacer(GlanceModifier.width(RING_GAP_BESIDE_DP.dp))
                RingView(memory, memLabel, d)
                Spacer(GlanceModifier.width(LEGEND_GAP_BESIDE_DP.dp))
                Column(modifier = GlanceModifier.width(legendWidth)) {
                    if (values) LegendHeader(legendWidth, cpuLabel, memLabel)
                    entries.forEach { LegendRow(it, legendWidth, values) }
                }
            }
        }
        UsageKind.SIDE -> {
            Row(modifier = GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
                Box(modifier = GlanceModifier.width(half), contentAlignment = Alignment.Center) { RingView(cpu, cpuLabel, d) }
                Spacer(GlanceModifier.width(gap))
                Box(modifier = GlanceModifier.width(half), contentAlignment = Alignment.Center) { RingView(memory, memLabel, d) }
            }
        }
        UsageKind.STACK -> {
            Column(modifier = GlanceModifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                RingView(cpu, cpuLabel, d)
                Spacer(GlanceModifier.height(6.dp))
                RingView(memory, memLabel, d)
            }
        }
        UsageKind.SINGLE -> {
            val worse = worseRing(cpu, memory)
            val other = if (worse === cpu) memory else cpu
            Row(modifier = GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
                RingView(worse, if (worse.id == "cpu") cpuLabel else memLabel, d)
                Column(modifier = GlanceModifier.defaultWeight().padding(start = 6.dp)) {
                    val pct = usedPercent(other)
                    Text(
                        if (other.id == "cpu") cpuLabel else memLabel,
                        maxLines = 1,
                        style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp),
                    )
                    Text(
                        usedPercentText(other),
                        maxLines = 1,
                        style = TextStyle(color = GlanceTheme.colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 13.sp),
                    )
                    LinearProgressIndicator(
                        progress = barFraction(pct),
                        modifier = GlanceModifier.fillMaxWidth().height(4.dp),
                        color = ColorProvider(Color(statusColourFor(pct))),
                        backgroundColor = GlanceTheme.colors.surfaceVariant,
                    )
                }
            }
        }
    }
}

/** The bitmap ring in an image view. The view has exactly the size of the bitmap in dp. */
@Composable
private fun RingView(ring: PanelRing, shortLabel: String, diameterDp: Double) {
    val context = LocalContext.current
    val views = remember(ring, shortLabel, diameterDp) { ringRemoteViews(context, ring, shortLabel, diameterDp) }
    Box(modifier = GlanceModifier.size(diameterDp.dp)) {
        AndroidRemoteViews(views, GlanceModifier.fillMaxSize())
    }
}

@Composable
private fun RingWithCaption(ring: PanelRing, shortLabel: String, diameterDp: Double, width: androidx.compose.ui.unit.Dp) {
    Column(modifier = GlanceModifier.width(width), horizontalAlignment = Alignment.CenterHorizontally) {
        RingView(ring, shortLabel, diameterDp)
        Text(
            captionText(shortLabel, ring),
            maxLines = 1,
            modifier = GlanceModifier.fillMaxWidth().height(CAPTION_DP.dp),
            style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp, textAlign = TextAlign.Center),
        )
    }
}

/** The titles over the two value columns. */
@Composable
private fun LegendHeader(width: androidx.compose.ui.unit.Dp, cpuLabel: String, memLabel: String) {
    val style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp, textAlign = TextAlign.End)
    Row(modifier = GlanceModifier.width(width).height(LEGEND_HEADER_DP.dp), verticalAlignment = Alignment.CenterVertically) {
        Spacer(GlanceModifier.defaultWeight())
        Text(cpuLabel, maxLines = 1, modifier = GlanceModifier.width(LEGEND_VALUE_DP.dp), style = style)
        Text(memLabel, maxLines = 1, modifier = GlanceModifier.width(LEGEND_VALUE_DP.dp), style = style)
    }
}

/** One legend row: dot, name and, when [values] is true, the two shares. */
@Composable
private fun LegendRow(entry: LegendEntry, width: androidx.compose.ui.unit.Dp, values: Boolean) {
    val valueStyle = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp, textAlign = TextAlign.End)
    Row(modifier = GlanceModifier.width(width).height(LEGEND_ROW_DP.dp), verticalAlignment = Alignment.CenterVertically) {
        Image(
            provider = ImageProvider(R.drawable.legend_dot),
            contentDescription = null,
            modifier = GlanceModifier.size(8.dp),
            colorFilter = ColorFilter.tint(DayNightColour(day = Color(entry.lightColour), night = Color(entry.darkColour))),
        )
        Spacer(GlanceModifier.width(5.dp))
        Text(
            entry.name,
            maxLines = 1,
            modifier = GlanceModifier.defaultWeight(),
            style = TextStyle(
                color = GlanceTheme.colors.onSurface,
                fontSize = 12.sp,
                fontWeight = if (entry.category) FontWeight.Medium else FontWeight.Normal,
            ),
        )
        if (values) {
            Text(entry.cpuText, maxLines = 1, modifier = GlanceModifier.width(LEGEND_VALUE_DP.dp), style = valueStyle)
            Text(entry.memText, maxLines = 1, modifier = GlanceModifier.width(LEGEND_VALUE_DP.dp), style = valueStyle)
        }
    }
}

class UsageDashboardReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = UsageDashboardWidget()

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
        removeWidgetData(context, appWidgetIds) { repository, id ->
            repository.removeRingsWidget(id)
        }
    }
}
