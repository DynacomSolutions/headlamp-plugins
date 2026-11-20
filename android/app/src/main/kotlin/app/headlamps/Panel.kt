package app.headlamps

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/** Panel status. Unknown values from a newer agent read as [UNKNOWN]. */
@Serializable
enum class PanelStatus {
    @SerialName("ok") OK,
    @SerialName("warn") WARN,
    @SerialName("crit") CRIT,
    @SerialName("unknown") UNKNOWN,
}

@Serializable
data class PanelInfo(
    val id: String,
    val title: String = "",
    val description: String = "",
    val plugin: String = "",
    val link: String = "",
    val refreshSeconds: Int = 900,
)

@Serializable
data class PanelList(val version: Int = 1, val panels: List<PanelInfo> = emptyList())

@Serializable
data class PanelStat(val label: String = "", val value: String = "", val status: PanelStatus = PanelStatus.UNKNOWN)

@Serializable
data class PanelRow(
    val label: String = "",
    val detail: String = "",
    val value: String = "",
    val fraction: Double? = null,
    val status: PanelStatus = PanelStatus.UNKNOWN,
    val link: String? = null,
)

@Serializable
data class PanelSeries(val label: String = "", val points: List<Double> = emptyList())

/** One arc of a ring. Children lie inside their parent and may sum to less than it. */
@Serializable
data class RingSegment(
    val key: String = "",
    val label: String = "",
    val value: Double = 0.0,
    val children: List<RingSegment> = emptyList(),
)

/** One ring of the usage dashboard: [capacity] is the full circle and [used] is the centre total. */
@Serializable
data class PanelRing(
    val id: String = "",
    val label: String = "",
    val unit: String = "",
    val capacity: Double = 0.0,
    val used: Double = 0.0,
    val segments: List<RingSegment> = emptyList(),
)

@Serializable
data class PanelModel(
    val version: Int = 1,
    val id: String = "",
    val title: String = "",
    val status: PanelStatus = PanelStatus.UNKNOWN,
    val summary: String = "",
    val generatedAt: String = "",
    val link: String = "",
    val stats: List<PanelStat> = emptyList(),
    val rows: List<PanelRow> = emptyList(),
    val series: List<PanelSeries> = emptyList(),
    val rings: List<PanelRing> = emptyList(),
)

/** What the worker stores for one panel widget. */
@Serializable
data class PanelSnapshot(
    val updatedAt: Long,
    val model: PanelModel? = null,
    val error: ErrorKind? = null,
    val detail: String? = null,
)

@Serializable
data class PanelConfig(val instanceId: String, val cluster: String, val panelId: String)

data class PanelWidgetState(val config: PanelConfig?, val instance: Instance?, val snapshot: PanelSnapshot?)

private fun rank(status: PanelStatus): Int = when (status) {
    PanelStatus.CRIT -> 0
    PanelStatus.WARN -> 1
    PanelStatus.UNKNOWN -> 2
    PanelStatus.OK -> 3
}

/** Worst first (crit, warn, unknown, ok). The sort is stable, so the agent's order stays inside a group. */
fun sortPanelRows(rows: List<PanelRow>): List<PanelRow> = rows.sortedBy { rank(it.status) }

/** The worse of two statuses. */
fun worseStatus(a: PanelStatus, b: PanelStatus): PanelStatus = if (rank(a) <= rank(b)) a else b

/** The row's own link, or the panel link. */
fun rowLink(row: PanelRow, model: PanelModel): String = row.link?.takeIf { it.isNotBlank() } ?: model.link

/** Reads the reason from an error body such as {"error":"..."} or a Kubernetes Status. */
fun errorDetail(body: String): String? {
    val obj = runCatching { AppJson.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
    val text = (obj["error"] as? JsonPrimitive)?.contentOrNull ?: (obj["message"] as? JsonPrimitive)?.contentOrNull
    return text?.trim()?.take(160)?.takeIf { it.isNotEmpty() }
}

