package app.headlamps

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.updateAll
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val repository = Repository(applicationContext)
        val client = HeadlampClient()
        val manager = GlanceAppWidgetManager(applicationContext)
        for (glanceId in manager.getGlanceIds(NodeUsageWidget::class.java)) {
            val widgetId = manager.getAppWidgetId(glanceId)
            val config = repository.widgetConfig(widgetId) ?: continue
            val instance = repository.instance(config.instanceId)
            val snapshot = if (instance == null) {
                Snapshot(config.cluster, System.currentTimeMillis(), error = ErrorKind.INSTANCE_MISSING)
            } else {
                client.snapshotOrError(instance.baseUrl, instance.token, config.cluster, System.currentTimeMillis())
            }
            repository.saveSnapshot(widgetId, snapshot)
        }
        NodeUsageWidget().updateAll(applicationContext)
        return Result.success()
    }

    companion object {
        private const val PERIODIC = "headlamps-periodic"
        private const val NOW = "headlamps-now"
        private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedulePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES)
                .setConstraints(network)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancelPeriodic(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        }

        fun refreshNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<RefreshWorker>().setConstraints(network).build()
            WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
