package app.headlamps

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import java.util.UUID

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val repository = Repository(applicationContext)
        setContent { HeadlampsTheme { InstancesScreen(repository) } }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InstancesScreen(repository: Repository) {
    val instances by repository.instances.collectAsState(initial = emptyList())
    var editing by remember { mutableStateOf<Instance?>(null) }
    val scope = rememberCoroutineScope()
    Scaffold(
        topBar = { TopAppBar(title = { Text(androidx.compose.ui.res.stringResource(R.string.instances_title)) }) },
        floatingActionButton = {
            FloatingActionButton(onClick = { editing = Instance("", "", "https://", "") }) { Text("+") }
        },
    ) { padding ->
        if (instances.isEmpty()) {
            Text(
                androidx.compose.ui.res.stringResource(R.string.instances_empty),
                modifier = Modifier.padding(padding).padding(16.dp),
            )
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(instances, key = { it.id }) { instance ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(instance.name, style = MaterialTheme.typography.titleMedium)
                            Text(instance.baseUrl, style = MaterialTheme.typography.bodySmall)
                            if (isCleartext(instance.baseUrl)) {
                                Text(
                                    androidx.compose.ui.res.stringResource(R.string.warning_http),
                                    color = MaterialTheme.colorScheme.error,
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                        TextButton(onClick = { editing = instance }) {
                            Text(androidx.compose.ui.res.stringResource(R.string.action_edit))
                        }
                    }
                }
            }
        }
    }
    editing?.let { current ->
        InstanceDialog(
            initial = current,
            isNew = instances.none { it.id == current.id },
            onSave = { saved -> scope.launch { repository.save(saved) }; editing = null },
            onDelete = { scope.launch { repository.delete(current.id) }; editing = null },
            onDismiss = { editing = null },
        )
    }
}

@Composable
private fun InstanceDialog(
    initial: Instance,
    isNew: Boolean,
    onSave: (Instance) -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(initial.name) }
    var url by remember { mutableStateOf(initial.baseUrl) }
    var token by remember { mutableStateOf(initial.token) }
    var result by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    val valid = name.isNotBlank() && url.trim().let { it.startsWith("http://") || it.startsWith("https://") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(androidx.compose.ui.res.stringResource(if (isNew) R.string.dialog_add else R.string.dialog_edit)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text(androidx.compose.ui.res.stringResource(R.string.field_name)) }, singleLine = true)
                OutlinedTextField(
                    url, { url = it; result = null },
                    label = { Text(androidx.compose.ui.res.stringResource(R.string.field_url)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    singleLine = true,
                )
                if (isCleartext(url)) {
                    Text(
                        androidx.compose.ui.res.stringResource(R.string.warning_http),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                OutlinedTextField(
                    token, { token = it; result = null },
                    label = { Text(androidx.compose.ui.res.stringResource(R.string.field_token)) },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                )
                TextButton(
                    enabled = valid && !testing,
                    onClick = {
                        testing = true
                        scope.launch {
                            result = try {
                                val clusters = HeadlampClient().clusters(url, token)
                                if (clusters.isEmpty()) {
                                    context.getString(R.string.test_no_clusters)
                                } else {
                                    context.getString(R.string.test_ok, clusters.joinToString(", "))
                                }
                            } catch (e: Exception) {
                                context.getString(errorText(classify(e)))
                            }
                            testing = false
                        }
                    },
                ) { Text(androidx.compose.ui.res.stringResource(R.string.action_test)) }
                result?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(
                enabled = valid,
                onClick = { onSave(Instance(initial.id.ifBlank { UUID.randomUUID().toString() }, name, url, token)) },
            ) { Text(androidx.compose.ui.res.stringResource(R.string.action_save)) }
        },
        dismissButton = {
            Row {
                if (!isNew) TextButton(onClick = onDelete) { Text(androidx.compose.ui.res.stringResource(R.string.action_delete)) }
                TextButton(onClick = onDismiss) { Text(androidx.compose.ui.res.stringResource(R.string.action_cancel)) }
            }
        },
    )
}
