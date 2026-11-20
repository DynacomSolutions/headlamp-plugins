package app.headlamps

import java.util.Locale
import kotlin.math.roundToLong

/** The text and legend decisions of the usage dashboard. No android imports. */

const val USAGE_PANEL_ID = "usage-dashboard"
const val LEGEND_MAX_ENTRIES = 40
private const val GIB = 1024.0 * 1024.0 * 1024.0

/** The used percent as a whole number with "%", or "-" when the capacity is not positive. */
fun usedPercentText(ring: PanelRing): String =
    if (ring.capacity.isFinite() && ring.capacity > 0.0) "${usedPercent(ring).roundToLong()}%" else "-"

/** The share of capacity as a whole percent. Values below 0.5 % read "<1%". */
fun shareText(value: Double, capacity: Double): String {
    if (!capacity.isFinite() || capacity <= 0.0) return "-"
    val pct = value / capacity * 100.0
    return if (pct < 0.5) "<1%" else "${pct.roundToLong()}%"
}

/** One decimal below 10, else a whole number. */
fun compactNumber(value: Double): String =
    if (value < 9.95) String.format(Locale.ROOT, "%.1f", value) else value.roundToLong().toString()

private fun scaled(ring: PanelRing, value: Double): Pair<Double, String> =
    if (ring.unit == "bytes") value / GIB to "GiB" else value to ring.unit

/** For example "51 of 96 cores" or "313 of 384 GiB". */
fun quantityText(ring: PanelRing): String {
    val (used, unit) = scaled(ring, ring.used)
    val (capacity, _) = scaled(ring, ring.capacity)
    return "${compactNumber(used)} of ${compactNumber(capacity)}${if (unit.isBlank()) "" else " $unit"}"
}

/** The caption under a ring, for example "CPU 51 of 96 cores". */
fun captionText(shortLabel: String, ring: PanelRing): String = "$shortLabel ${quantityText(ring)}"

/** The spoken description of a ring, for example "CPU 53% of 96 cores. Shop 12%, System 9%". */
fun ringDescription(shortLabel: String, ring: PanelRing): String {
    val (capacity, unit) = scaled(ring, ring.capacity)
    val head = "$shortLabel ${usedPercentText(ring)} of ${compactNumber(capacity)}${if (unit.isBlank()) "" else " $unit"}"
    val parts = ring.segments.filter { it.value > 0.0 }.take(6).map { "${it.label.ifBlank { it.key }} ${shareText(it.value, ring.capacity)}" }
    return if (parts.isEmpty()) head else "$head. ${parts.joinToString(", ")}"
}

/**
 * One row of the combined legend. [category] is true for a first-level segment. The texts are the
 * share of the capacity of that ring, or "-" when the ring does not hold the key.
 */
data class LegendEntry(
    val key: String,
    val name: String,
    val category: Boolean,
    val lightColour: Int,
    val darkColour: Int,
    val cpuText: String,
    val memText: String,
)

private class LegendAcc(val key: String, val name: String, val category: Boolean) {
    val share = arrayOfNulls<Double>(2)
    var bestShare = -1.0
    var lightCss = ""
    var darkCss = ""
    var text = arrayOf("-", "-")

    fun add(ringIndex: Int, ring: PanelRing, value: Double, lightCss: String, darkCss: String) {
        val s = value / ring.capacity
        text[ringIndex] = shareText(value, ring.capacity)
        share[ringIndex] = s
        if (s > bestShare) {
            bestShare = s
            this.lightCss = lightCss
            this.darkCss = darkCss
        }
    }
}

private fun live(value: Double): Boolean = value.isFinite() && value > 0.0

/**
 * One legend for both rings. First every category (union over both rings by key), then every
 * child (union by key). Each group is sorted by the higher of the two shares, biggest first.
 * A child takes the arc colour of the ring where its share is higher. At most [LEGEND_MAX_ENTRIES].
 */
fun combinedLegend(cpu: PanelRing, memory: PanelRing): List<LegendEntry> {
    val categories = LinkedHashMap<String, LegendAcc>()
    val children = LinkedHashMap<String, LegendAcc>()
    listOf(cpu, memory).forEachIndexed { ringIndex, ring ->
        if (!(ring.capacity.isFinite() && ring.capacity > 0.0)) return@forEachIndexed
        for (segment in ring.segments) {
            if (!live(segment.value)) continue
            val light = categoryColourCss(segment.key, false)
            val dark = categoryColourCss(segment.key, true)
            categories.getOrPut(segment.key) { LegendAcc(segment.key, segment.label.ifBlank { segment.key }, true) }
                .add(ringIndex, ring, segment.value, light, dark)
            // The index is the position in the ring, as the ring geometry counts it.
            segment.children.forEachIndexed { index, child ->
                if (!live(child.value)) return@forEachIndexed
                children.getOrPut(child.key) { LegendAcc(child.key, child.label.ifBlank { child.key }, false) }
                    .add(ringIndex, ring, child.value, shadeCss(light, 2, index), shadeCss(dark, 2, index))
            }
        }
    }
    fun sorted(map: Map<String, LegendAcc>) = map.values.sortedByDescending { it.bestShare }
    return (sorted(categories) + sorted(children)).take(LEGEND_MAX_ENTRIES).map {
        val light = if (it.category) categoryColour(it.key, false) else cssToArgb(it.lightCss)
        val dark = if (it.category) categoryColour(it.key, true) else cssToArgb(it.darkCss)
        LegendEntry(it.key, it.name, it.category, light, dark, it.text[0], it.text[1])
    }
}

/** The ring with the higher used share. Ties go to CPU (the first ring). */
fun worseRing(first: PanelRing, second: PanelRing): PanelRing =
    if (usedPercent(second) > usedPercent(first)) second else first
