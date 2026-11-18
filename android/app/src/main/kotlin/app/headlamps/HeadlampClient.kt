package app.headlamps

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

class HeadlampClient(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build(),
) {
    /** Returns the cluster names. Throws [FetchException]. */
    suspend fun clusters(base: String, token: String): List<String> {
        val body = get(configUrl(base), token, metrics = false)
        return wrap { AppJson.decodeFromString<ConfigResponse>(body).clusters.map { it.name }.filter { it.isNotBlank() } }
    }

    /** Fetches usage for one cluster. Throws [FetchException]. */
    suspend fun snapshot(base: String, token: String, cluster: String, now: Long): Snapshot {
        val metricsBody = get(metricsUrl(base, cluster), token, metrics = true)
        val nodesBody = get(nodesUrl(base, cluster), token, metrics = false)
        return wrap {
            buildSnapshot(
                cluster,
                AppJson.decodeFromString<NodeMetricsList>(metricsBody),
                AppJson.decodeFromString<NodeList>(nodesBody),
                now,
            )
        }
    }

    /** Like [snapshot], but returns an error snapshot instead of throwing. */
    suspend fun snapshotOrError(base: String, token: String, cluster: String, now: Long): Snapshot =
        try {
            snapshot(base, token, cluster, now)
        } catch (e: Exception) {
            Snapshot(cluster = cluster, updatedAt = now, error = classify(e))
        }

    /** Lists the panels of the headlamp-agent. Throws [FetchException]. */
    suspend fun panels(base: String, token: String, cluster: String): List<PanelInfo> {
        val body = get(panelsUrl(base, cluster), token, metrics = false, agent = true)
        return wrap { AppJson.decodeFromString<PanelList>(body).panels }
    }

    /** Fetches one panel. Returns an error snapshot instead of throwing. */
    suspend fun panelOrError(base: String, token: String, cluster: String, panelId: String, now: Long): PanelSnapshot =
        try {
            val body = get(panelUrl(base, cluster, panelId), token, metrics = false, agent = true)
            PanelSnapshot(updatedAt = now, model = wrap { AppJson.decodeFromString<PanelModel>(body) })
        } catch (e: Exception) {
            PanelSnapshot(updatedAt = now, error = classify(e), detail = (e as? FetchException)?.detail)
        }

    private fun <T> wrap(block: () -> T): T =
        try {
            block()
        } catch (e: Exception) {
            throw FetchException(classify(e), cause = e)
        }

    private suspend fun get(url: String, token: String, metrics: Boolean, agent: Boolean = false): String =
        withContext(Dispatchers.IO) {
            try {
                val request = Request.Builder().url(url).header("Accept", "application/json").apply {
                    if (token.isNotBlank()) header("Authorization", "Bearer ${token.trim()}")
                }.build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        if (agent) {
                            val body = response.body?.string().orEmpty().take(2000)
                            throw FetchException(classifyAgent(response.code, body), response.code, detail = errorDetail(body))
                        }
                        throw FetchException(classifyHttp(response.code, metrics), response.code)
                    }
                    response.body?.string().orEmpty()
                }
            } catch (e: FetchException) {
                throw e
            } catch (e: IOException) {
                throw FetchException(ErrorKind.UNREACHABLE, cause = e)
            } catch (e: IllegalArgumentException) {
                throw FetchException(ErrorKind.INVALID_URL, cause = e)
            }
        }
}
