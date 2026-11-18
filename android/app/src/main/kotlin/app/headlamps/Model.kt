package app.headlamps

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

val AppJson = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
}

const val HIGH_THRESHOLD = 75.0
const val CRITICAL_THRESHOLD = 90.0

@Serializable
data class ConfigResponse(val clusters: List<ClusterInfo> = emptyList())

@Serializable
data class ClusterInfo(val name: String = "")

@Serializable
data class ObjectMeta(val name: String = "")

@Serializable
data class ResourceMap(val cpu: String = "", val memory: String = "")

@Serializable
data class NodeMetricsList(val items: List<NodeMetrics> = emptyList())

@Serializable
data class NodeMetrics(val metadata: ObjectMeta = ObjectMeta(), val usage: ResourceMap = ResourceMap())

@Serializable
data class NodeList(val items: List<KubeNode> = emptyList())

@Serializable
data class KubeNode(val metadata: ObjectMeta = ObjectMeta(), val status: NodeStatus = NodeStatus())

@Serializable
data class NodeStatus(val allocatable: ResourceMap = ResourceMap())

@Serializable
data class NodeUsage(val name: String, val cpuPct: Double, val memPct: Double) {
    val worstPct: Double get() = maxOf(cpuPct, memPct)
}

@Serializable
data class Snapshot(
    val cluster: String,
    val updatedAt: Long,
    val nodes: List<NodeUsage> = emptyList(),
    val cpuPct: Double = 0.0,
    val memPct: Double = 0.0,
    val error: ErrorKind? = null,
)

enum class Level { NORMAL, HIGH, CRITICAL }

fun levelOf(pct: Double): Level = when {
    pct > CRITICAL_THRESHOLD -> Level.CRITICAL
    pct > HIGH_THRESHOLD -> Level.HIGH
    else -> Level.NORMAL
}

/** Bar fill for a percentage. Usage above 100% fills the bar; the text still shows the real value. */
fun barFraction(pct: Double): Float = (pct / 100.0).coerceIn(0.0, 1.0).toFloat()

fun percent(used: Double, total: Double): Double =
    if (total <= 0.0) 0.0 else used / total * 100.0

/** Sorts by the worse of CPU and memory, highest first. Ties sort by name. */
fun sortNodes(nodes: List<NodeUsage>): List<NodeUsage> =
    nodes.sortedWith(compareByDescending<NodeUsage> { it.worstPct }.thenBy { it.name })

/** Joins metrics with node capacity. Nodes with no usable data are left out. */
fun buildSnapshot(cluster: String, metrics: NodeMetricsList, nodes: NodeList, now: Long): Snapshot {
    val capacity = nodes.items.associateBy { it.metadata.name }
    var usedCpu = 0.0
    var usedMem = 0.0
    var totalCpu = 0.0
    var totalMem = 0.0
    val rows = metrics.items.mapNotNull { m ->
        val node = capacity[m.metadata.name] ?: return@mapNotNull null
        val cpu = parseQuantity(m.usage.cpu) ?: return@mapNotNull null
        val mem = parseQuantity(m.usage.memory) ?: return@mapNotNull null
        val cpuCap = parseQuantity(node.status.allocatable.cpu) ?: return@mapNotNull null
        val memCap = parseQuantity(node.status.allocatable.memory) ?: return@mapNotNull null
        usedCpu += cpu
        usedMem += mem
        totalCpu += cpuCap
        totalMem += memCap
        NodeUsage(m.metadata.name, percent(cpu, cpuCap), percent(mem, memCap))
    }
    return Snapshot(
        cluster = cluster,
        updatedAt = now,
        nodes = sortNodes(rows),
        cpuPct = percent(usedCpu, totalCpu),
        memPct = percent(usedMem, totalMem),
    )
}
