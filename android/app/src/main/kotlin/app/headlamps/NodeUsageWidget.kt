package app.headlamps

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
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
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, LARGE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val repository = Repository(context)
        val widgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val config = repository.widgetConfig(widgetId)
        val instance = config?.let { repository.instance(it.instanceId) }
        val snapshot = repository.snapshot(widgetId)
        val link = if (config != null && instance != null) usagePageUrl(instance.baseUrl, config.cluster) else null
        provideContent {
            GlanceTheme {
                WidgetBody(config?.cluster.orEmpty(), snapshot, link)
            }
        }
    }
}

@Composable
private fun WidgetBody(cluster: String, snapshot: Snapshot?, link: String?) {
    val context = LocalContext.current
    val compact = LocalSize.current.let { it.width < LARGE.width || it.height < LARGE.height }
    val open = if (link != null) {
        GlanceModifier.clickable(actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))))
    } else {
        GlanceModifier
    }
    Column(
        modifier = GlanceModifier.fillMaxSize().background(GlanceTheme.colors.widgetBackground).padding(8.dp),
    ) {
        Header(cluster, snapshot, compact)
        Spacer(GlanceModifier.height(4.dp))
        when {
            snapshot == null -> Message(context.getString(R.string.widget_loading), open)
            snapshot.error != null -> Message(context.getString(errorText(snapshot.error)), open)
            snapshot.nodes.isEmpty() -> Message(context.getString(R.string.widget_no_nodes), open)
            compact -> Totals(snapshot, open)
            else -> NodeList(snapshot, link)
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
    Column(modifier = modifier.fillMaxSize()) {
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
        LinearProgressIndicator(
            progress = (pct / 100.0).coerceIn(0.0, 1.0).toFloat(),
            modifier = GlanceModifier.fillMaxWidth().height(6.dp),
            color = colourFor(pct),
            backgroundColor = GlanceTheme.colors.surfaceVariant,
        )
    }
}

@Composable
private fun NodeList(snapshot: Snapshot, link: String?) {
    val context = LocalContext.current
    val open = if (link != null) {
        GlanceModifier.clickable(actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))))
    } else {
        GlanceModifier
    }
    Row(modifier = GlanceModifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Text(
            context.getString(R.string.widget_total, snapshot.cpuPct.toInt(), snapshot.memPct.toInt()),
            style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp),
        )
    }
    LazyColumn(modifier = GlanceModifier.fillMaxSize()) {
        items(snapshot.nodes) { node ->
            Column(modifier = open.fillMaxWidth().padding(vertical = 3.dp)) {
                Text(
                    node.name,
                    maxLines = 1,
                    style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.sp),
                )
                Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = GlanceModifier.defaultWeight()) {
                        Text("${context.getString(R.string.label_cpu)} ${node.cpuPct.toInt()}%", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp))
                        LinearProgressIndicator(
                            progress = (node.cpuPct / 100.0).coerceIn(0.0, 1.0).toFloat(),
                            modifier = GlanceModifier.fillMaxWidth().height(5.dp),
                            color = colourFor(node.cpuPct),
                            backgroundColor = GlanceTheme.colors.surfaceVariant,
                        )
                    }
                    Spacer(GlanceModifier.width(8.dp))
                    Column(modifier = GlanceModifier.defaultWeight()) {
                        Text("${context.getString(R.string.label_memory)} ${node.memPct.toInt()}%", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp))
                        LinearProgressIndicator(
                            progress = (node.memPct / 100.0).coerceIn(0.0, 1.0).toFloat(),
                            modifier = GlanceModifier.fillMaxWidth().height(5.dp),
                            color = colourFor(node.memPct),
                            backgroundColor = GlanceTheme.colors.surfaceVariant,
                        )
                    }
                }
            }
        }
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
