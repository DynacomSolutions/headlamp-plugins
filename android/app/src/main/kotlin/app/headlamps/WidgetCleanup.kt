package app.headlamps

import android.content.BroadcastReceiver
import android.content.Context
import android.util.Log
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The scope for clean-up work after a widget is removed. It does not belong to a receiver, so the
 * work can finish after the receiver call returns.
 */
internal val widgetCleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * Runs [block] in this scope, then calls [finish] once when it is not null. [finish] runs when the
 * block throws as well. A failure of the block is passed to [onError] and never crashes the app.
 * Nothing here uses an Android class, so a plain JVM test can run it.
 */
internal fun CoroutineScope.launchCleanup(
    finish: (() -> Unit)?,
    onError: (Throwable) -> Unit = {},
    block: suspend () -> Unit,
): Job = launch {
    try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        onError(e)
    } finally {
        finish?.invoke()
    }
}

/**
 * Removes the stored data of deleted widgets. Call it after super.onDeleted. [GlanceAppWidgetReceiver.onDeleted] already calls
 * goAsync() in the same broadcast, so a second call returns null. The result is optional here:
 * with it, the broadcast stays alive until the clean-up ends. Without it, the clean-up still runs.
 */
internal fun GlanceAppWidgetReceiver.removeWidgetData(
    context: Context,
    appWidgetIds: IntArray,
    remove: suspend (Repository, Int) -> Unit,
) {
    val pending: BroadcastReceiver.PendingResult? = goAsync()
    val app = context.applicationContext
    widgetCleanupScope.launchCleanup(
        finish = pending?.let { p -> { p.finish() } },
        onError = { Log.w("Headlamps", "Widget clean-up failed", it) },
    ) {
        val repository = Repository(app)
        appWidgetIds.forEach { remove(repository, it) }
    }
}
