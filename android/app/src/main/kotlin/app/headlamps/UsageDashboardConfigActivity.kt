package app.headlamps

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.res.stringResource
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/** Picks the instance and the cluster for a usage dashboard widget. It reuses the screen of the node usage widget. */
class UsageDashboardConfigActivity : ComponentActivity() {
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(Activity.RESULT_CANCELED)
        widgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        val repository = Repository(applicationContext)
        setContent {
            HeadlampsTheme {
                ConfigScreen(
                    repository,
                    stringResource(R.string.usage_config_title),
                    onOpenApp = { startActivity(Intent(this, MainActivity::class.java)) },
                ) { instance, cluster ->
                    lifecycleScope.launch { finishWith(repository, instance, cluster) }
                }
            }
        }
    }

    private suspend fun finishWith(repository: Repository, instance: Instance, cluster: String) {
        repository.saveRingsConfig(widgetId, WidgetConfig(instance.id, cluster))
        RefreshWorker.schedulePeriodic(applicationContext)
        RefreshWorker.refreshNow(applicationContext)
        val glanceId = GlanceAppWidgetManager(applicationContext).getGlanceIdBy(widgetId)
        UsageDashboardWidget().update(applicationContext, glanceId)
        setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        finish()
    }
}
