package app.headlamps

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidgetManager
import kotlinx.coroutines.launch
import androidx.lifecycle.lifecycleScope

class WidgetConfigActivity : ComponentActivity() {
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
                ConfigScreen(repository, onOpenApp = { startActivity(Intent(this, MainActivity::class.java)) }) { instance, cluster ->
                    lifecycleScope.launch { finishWith(repository, instance, cluster) }
                }
            }
        }
    }

    private suspend fun finishWith(repository: Repository, instance: Instance, cluster: String) {
        repository.saveWidgetConfig(widgetId, WidgetConfig(instance.id, cluster))
        RefreshWorker.schedulePeriodic(applicationContext)
        RefreshWorker.refreshNow(applicationContext)
        val glanceId = GlanceAppWidgetManager(applicationContext).getGlanceIdBy(widgetId)
        NodeUsageWidget().update(applicationContext, glanceId)
        setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        finish()
    }
}

@Composable
private fun ConfigScreen(
    repository: Repository,
    onOpenApp: () -> Unit,
    onDone: (Instance, String) -> Unit,
) {
    val instances by repository.instances.collectAsState(initial = emptyList())
    var selected by remember { mutableStateOf<Instance?>(null) }
    var clusters by remember { mutableStateOf<List<String>>(emptyList()) }
    var cluster by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<ErrorKind?>(null) }
    val current = selected

    LaunchedEffect(current?.id) {
        clusters = emptyList()
        cluster = null
        error = null
        if (current != null) {
            try {
                clusters = HeadlampClient().clusters(current.baseUrl, current.token)
                cluster = clusters.firstOrNull()
            } catch (e: Exception) {
                error = classify(e)
            }
        }
    }

    Scaffold { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(stringResource(R.string.config_title), style = MaterialTheme.typography.headlineSmall)
            if (instances.isEmpty()) {
                Text(stringResource(R.string.instances_empty))
                Button(onClick = onOpenApp) { Text(stringResource(R.string.config_open_app)) }
            }
            Text(stringResource(R.string.config_pick_instance), style = MaterialTheme.typography.titleMedium)
            instances.forEach { instance ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = current?.id == instance.id, onClick = { selected = instance })
                    Text(instance.name)
                }
            }
            if (current != null) {
                Text(stringResource(R.string.config_pick_cluster), style = MaterialTheme.typography.titleMedium)
                error?.let { Text(stringResource(errorText(it)), color = MaterialTheme.colorScheme.error) }
                clusters.forEach { name ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = cluster == name, onClick = { cluster = name })
                        Text(name)
                    }
                }
            }
            Button(
                enabled = current != null && cluster != null,
                onClick = { onDone(current!!, cluster!!) },
            ) { Text(stringResource(R.string.action_add_widget)) }
        }
    }
}
