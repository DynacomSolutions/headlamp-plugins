package app.headlamps

import android.content.Context
import android.content.Intent
import android.appwidget.AppWidgetManager
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import kotlinx.coroutines.flow.first
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
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
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.launch

private val SMALL = DpSize(110.dp, 110.dp)
private val TALL = DpSize(110.dp, 180.dp)
private val LARGE = DpSize(250.dp, 180.dp)

private val NORMAL_COLOUR = Color(0xFF2E7D32)
private val HIGH_COLOUR = Color(0xFFF9A825)
private val CRITICAL_COLOUR = Color(0xFFC62828)

private fun colourFor(pct: Double): ColorProvider = ColorProvider(
    when (levelOf(pct)) {
        Level.NORMAL -> NORMAL_COLOUR
        Level.HIGH -> HIGH_COLOUR
        Level.CRITICAL -> CRITICAL_COLOUR
    },
)

class NodeUsageWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, TALL, LARGE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val repository = Repository(context)
        val widgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val flow = repository.widgetState(widgetId)
        val first = flow.first()
        provideContent {
            // Read inside the composition, so that new data recomposes the widget.
            val state by flow.collectAsState(initial = first)
            val config = state.config
            val link = if (config != null && state.instance != null) usagePageUrl(state.instance!!.baseUrl, config.cluster) else null
            GlanceTheme {
                WidgetBody(widgetId, config != null, config?.cluster.orEmpty(), state.snapshot, link)
            }
        }
    }
}

@Composable
private fun WidgetBody(widgetId: Int, configured: Boolean, cluster: String, snapshot: Snapshot?, link: String?) {
    val context = LocalContext.current
    val size = LocalSize.current
    val tall = size.height >= TALL.height
    val wide = size.width >= LARGE.width
    val compact = !wide
    val open = if (link != null) {
        GlanceModifier.clickable(actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))))
    } else {
        GlanceModifier
    }
    // A unique data URI per widget keeps the intent extras apart for each widget.
    val configure = GlanceModifier.clickable(
        actionStartActivity(
            Intent(context, WidgetConfigActivity::class.java)
                .setData(Uri.parse("headlamps://configure/$widgetId"))
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId),
        ),
    )
    Column(
        modifier = GlanceModifier.fillMaxSize().background(GlanceTheme.colors.widgetBackground).padding(8.dp),
    ) {
        Header(cluster, snapshot, compact)
        Spacer(GlanceModifier.height(4.dp))
        when {
            !configured -> Message(context.getString(R.string.widget_choose), configure)
            snapshot == null -> Message(context.getString(R.string.widget_loading), open)
            snapshot.error != null -> Message(context.getString(errorText(snapshot.error)), open)
            snapshot.nodes.isEmpty() -> Message(context.getString(R.string.widget_no_nodes), open)
            else -> {
                Totals(snapshot, open)
                if (tall) {
                    Spacer(GlanceModifier.height(6.dp))
                    NodeList(snapshot, link, wide)
                }
            }
        }
    }
}

@Composable
private fun Header(cluster: String, snapshot: Snapshot?, compact: Boolean) {
    val context = LocalContext.current
    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = GlanceModifier.defaultWeight()) {
            Text(
                cluster.ifBlank { context.getString(R.string.app_name) },
                maxLines = 1,
                style = TextStyle(color = GlanceTheme.colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 13.sp),
            )
            if (snapshot != null && !compact) {
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
private fun Message(text: String, modifier: GlanceModifier) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.sp))
    }
}

@Composable
private fun Totals(snapshot: Snapshot, modifier: GlanceModifier) {
    val context = LocalContext.current
    Column(modifier = modifier.fillMaxWidth()) {
        UsageBar(context.getString(R.string.label_cpu), snapshot.cpuPct)
        Spacer(GlanceModifier.height(6.dp))
        UsageBar(context.getString(R.string.label_memory), snapshot.memPct)
    }
}

@Composable
private fun UsageBar(label: String, pct: Double) {
    Column(modifier = GlanceModifier.fillMaxWidth()) {
        Text(
            "$label ${pct.toInt()}%",
            style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
        Bar(pct, 6)
    }
}

@Composable
private fun Bar(pct: Double, heightDp: Int, modifier: GlanceModifier = GlanceModifier.fillMaxWidth()) {
    LinearProgressIndicator(
        progress = barFraction(pct),
        modifier = modifier.height(heightDp.dp),
        color = colourFor(pct),
        backgroundColor = GlanceTheme.colors.surfaceVariant,
    )
}

@Composable
private fun NodeList(snapshot: Snapshot, link: String?, wide: Boolean) {
    val open = if (link != null) {
        GlanceModifier.clickable(actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))))
    } else {
        GlanceModifier
    }
    LazyColumn(modifier = GlanceModifier.fillMaxSize()) {
        items(snapshot.nodes) { node ->
            Column(modifier = open.fillMaxWidth().padding(vertical = 3.dp)) {
                Text(
                    node.name,
                    maxLines = 1,
                    style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.sp),
                )
                if (wide) FullRow(node) else CompactRows(node)
            }
        }
    }
}

@Composable
private fun FullRow(node: NodeUsage) {
    val context = LocalContext.current
    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = GlanceModifier.defaultWeight()) {
            Text("${context.getString(R.string.label_cpu)} ${node.cpuPct.toInt()}%", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp))
            Bar(node.cpuPct, 5)
        }
        Spacer(GlanceModifier.width(8.dp))
        Column(modifier = GlanceModifier.defaultWeight()) {
            Text("${context.getString(R.string.label_memory)} ${node.memPct.toInt()}%", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp))
            Bar(node.memPct, 5)
        }
    }
}

@Composable
private fun CompactRows(node: NodeUsage) {
    CompactBar("C", node.cpuPct)
    CompactBar("M", node.memPct)
}

@Composable
private fun CompactBar(label: String, pct: Double) {
    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp), modifier = GlanceModifier.width(12.dp))
        Bar(pct, 4, GlanceModifier.defaultWeight())
        Text(
            "${pct.toInt()}%",
            style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp),
            modifier = GlanceModifier.width(34.dp).padding(start = 4.dp),
        )
    }
}

fun errorText(kind: ErrorKind?): Int = when (kind) {
    ErrorKind.UNAUTHORIZED -> R.string.error_unauthorised
    ErrorKind.METRICS_MISSING -> R.string.error_metrics_missing
    ErrorKind.NOT_FOUND -> R.string.error_not_found
    ErrorKind.SERVER -> R.string.error_server
    ErrorKind.BAD_RESPONSE -> R.string.error_bad_response
    ErrorKind.INVALID_URL -> R.string.error_invalid_url
    ErrorKind.INSTANCE_MISSING -> R.string.error_instance_missing
    ErrorKind.UNREACHABLE, null -> R.string.error_unreachable
}

class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        RefreshWorker.refreshNow(context)
    }
}

class NodeUsageReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NodeUsageWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        RefreshWorker.schedulePeriodic(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        RefreshWorker.cancelPeriodic(context)
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        val pending = goAsync()
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).launchAndFinish(pending) {
            val repository = Repository(context)
            appWidgetIds.forEach { repository.removeWidget(it) }
        }
    }
}

private fun kotlinx.coroutines.CoroutineScope.launchAndFinish(
    pending: android.content.BroadcastReceiver.PendingResult,
    block: suspend () -> Unit,
) {
    this.launch {
        try {
            block()
        } finally {
            pending.finish()
        }
    }
}
