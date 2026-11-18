package app.headlamps

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val Context.dataStore by preferencesDataStore("headlamps")

/** Encrypts tokens with an AES/GCM key that never leaves the Android Keystore. */
object TokenCipher {
    private const val ALIAS = "headlamps_token_key"
    private const val PROVIDER = "AndroidKeyStore"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun encrypt(plain: String): String {
        if (plain.isEmpty()) return ""
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val data = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(data, Base64.NO_WRAP)
    }

    fun decrypt(encoded: String): String {
        if (encoded.isEmpty()) return ""
        return try {
            val data = Base64.decode(encoded, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data, 0, 12))
            String(cipher.doFinal(data, 12, data.size - 12), Charsets.UTF_8)
        } catch (e: Exception) {
            ""
        }
    }
}

data class WidgetState(val config: WidgetConfig?, val instance: Instance?, val snapshot: Snapshot?)

data class Instance(val id: String, val name: String, val baseUrl: String, val token: String)

@Serializable
private data class StoredInstance(val id: String, val name: String, val baseUrl: String, val token: String)

@Serializable
data class WidgetConfig(val instanceId: String, val cluster: String)

class Repository(private val context: Context) {
    private val instancesKey = stringPreferencesKey("instances")
    private val listSerializer = ListSerializer(StoredInstance.serializer())

    val instances: Flow<List<Instance>> = context.dataStore.data.map { prefs ->
        decode(prefs[instancesKey])
    }

    private fun decode(text: String?): List<Instance> =
        if (text == null) {
            emptyList()
        } else {
            runCatching { AppJson.decodeFromString(listSerializer, text) }.getOrDefault(emptyList())
                .map { Instance(it.id, it.name, it.baseUrl, TokenCipher.decrypt(it.token)) }
        }

    /** Emits again whenever the widget config, its instance or its snapshot changes. */
    fun widgetState(widgetId: Int): Flow<WidgetState> = context.dataStore.data.map { prefs ->
        val config = prefs[stringPreferencesKey("widget_$widgetId")]
            ?.let { runCatching { AppJson.decodeFromString<WidgetConfig>(it) }.getOrNull() }
        val instance = config?.let { c -> decode(prefs[instancesKey]).firstOrNull { it.id == c.instanceId } }
        val snapshot = prefs[stringPreferencesKey("snap_$widgetId")]
            ?.let { runCatching { AppJson.decodeFromString<Snapshot>(it) }.getOrNull() }
        WidgetState(config, instance, snapshot)
    }.distinctUntilChanged()

    suspend fun instance(id: String): Instance? = instances.first().firstOrNull { it.id == id }

    /** Adds the instance, or replaces the one with the same id. */
    suspend fun save(instance: Instance) {
        val stored = StoredInstance(
            instance.id.ifBlank { UUID.randomUUID().toString() },
            instance.name.trim(),
            normaliseBase(instance.baseUrl),
            TokenCipher.encrypt(instance.token.trim()),
        )
        context.dataStore.edit { prefs ->
            val list = runCatching { prefs[instancesKey]?.let { AppJson.decodeFromString(listSerializer, it) } }
                .getOrNull().orEmpty()
            val next = if (list.any { it.id == stored.id }) list.map { if (it.id == stored.id) stored else it } else list + stored
            prefs[instancesKey] = AppJson.encodeToString(listSerializer, next)
        }
    }

    suspend fun delete(id: String) {
        context.dataStore.edit { prefs ->
            val list = runCatching { prefs[instancesKey]?.let { AppJson.decodeFromString(listSerializer, it) } }
                .getOrNull().orEmpty()
            prefs[instancesKey] = AppJson.encodeToString(listSerializer, list.filter { it.id != id })
        }
    }

    suspend fun widgetConfig(widgetId: Int): WidgetConfig? =
        context.dataStore.data.first()[stringPreferencesKey("widget_$widgetId")]?.let {
            runCatching { AppJson.decodeFromString<WidgetConfig>(it) }.getOrNull()
        }

    suspend fun saveWidgetConfig(widgetId: Int, config: WidgetConfig) {
        context.dataStore.edit { it[stringPreferencesKey("widget_$widgetId")] = AppJson.encodeToString(WidgetConfig.serializer(), config) }
    }

    suspend fun removeWidget(widgetId: Int) {
        context.dataStore.edit {
            it.remove(stringPreferencesKey("widget_$widgetId"))
            it.remove(stringPreferencesKey("snap_$widgetId"))
        }
    }

    suspend fun snapshot(widgetId: Int): Snapshot? =
        context.dataStore.data.first()[stringPreferencesKey("snap_$widgetId")]?.let {
            runCatching { AppJson.decodeFromString<Snapshot>(it) }.getOrNull()
        }

    suspend fun saveSnapshot(widgetId: Int, snapshot: Snapshot) {
        context.dataStore.edit { it[stringPreferencesKey("snap_$widgetId")] = AppJson.encodeToString(Snapshot.serializer(), snapshot) }
    }

    /** Emits again whenever the panel widget config, its instance or its snapshot changes. */
    fun panelState(widgetId: Int): Flow<PanelWidgetState> = context.dataStore.data.map { prefs ->
        val config = prefs[stringPreferencesKey("panel_$widgetId")]
            ?.let { runCatching { AppJson.decodeFromString<PanelConfig>(it) }.getOrNull() }
        val instance = config?.let { c -> decode(prefs[instancesKey]).firstOrNull { it.id == c.instanceId } }
        val snapshot = prefs[stringPreferencesKey("panelsnap_$widgetId")]
            ?.let { runCatching { AppJson.decodeFromString<PanelSnapshot>(it) }.getOrNull() }
        PanelWidgetState(config, instance, snapshot)
    }.distinctUntilChanged()

    suspend fun panelConfig(widgetId: Int): PanelConfig? =
        context.dataStore.data.first()[stringPreferencesKey("panel_$widgetId")]?.let {
            runCatching { AppJson.decodeFromString<PanelConfig>(it) }.getOrNull()
        }

    suspend fun savePanelConfig(widgetId: Int, config: PanelConfig) {
        context.dataStore.edit { it[stringPreferencesKey("panel_$widgetId")] = AppJson.encodeToString(PanelConfig.serializer(), config) }
    }

    suspend fun savePanelSnapshot(widgetId: Int, snapshot: PanelSnapshot) {
        context.dataStore.edit { it[stringPreferencesKey("panelsnap_$widgetId")] = AppJson.encodeToString(PanelSnapshot.serializer(), snapshot) }
    }

    suspend fun removePanelWidget(widgetId: Int) {
        context.dataStore.edit {
            it.remove(stringPreferencesKey("panel_$widgetId"))
            it.remove(stringPreferencesKey("panelsnap_$widgetId"))
        }
    }
}
