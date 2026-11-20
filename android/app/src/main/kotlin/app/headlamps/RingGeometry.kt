package app.headlamps

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/*
 * Geometry and colour decisions for one usage ring. This file has no android imports, so JVM
 * tests cover it. The drawing code in RingBitmap.kt only follows these numbers.
 *
 * All radii are fractions of the outer radius R. Angles are in degrees. They start at
 * 12 o'clock and go clockwise.
 */

const val STATUS_OK = 0xFF2E7D32.toInt()
const val STATUS_HIGH = 0xFFF9A825.toInt()
const val STATUS_CRITICAL = 0xFFC62828.toInt()

/** The status colour of the existing widgets for a use percentage. */
fun statusColourFor(pct: Double): Int = when (levelOf(pct)) {
    Level.NORMAL -> STATUS_OK
    Level.HIGH -> STATUS_HIGH
    Level.CRITICAL -> STATUS_CRITICAL
}

/** Below this diameter (dp) the ring draws one level only. */
const val ONE_LEVEL_BELOW_DP = 76.0

/** A separator is drawn only between arcs that are at least this long (dp) on the middle radius. */
const val SEPARATOR_MIN_ARC_DP = 4.0

/** The status ring is never thinner than this (dp). */
const val STATUS_MIN_THICKNESS_DP = 2.5

private const val STATUS_INNER = 0.50
private const val STATUS_OUTER = 0.56
private const val CATEGORY_INNER = 0.60
private const val CATEGORY_INNER_ONE_LEVEL = 0.62
private const val CATEGORY_OUTER = 0.79
private const val CONSUMER_INNER = 0.805
private const val OUTER = 1.0

/** Text in the hole must fit inside this radius. */
const val CENTRE_RADIUS = 0.44

/** Text heights as fractions of R. */
const val CENTRE_TOP_HEIGHT = 0.30
const val CENTRE_BOTTOM_HEIGHT = 0.17

data class Band(val inner: Double, val outer: Double) {
    val mid: Double get() = (inner + outer) / 2
}

data class ArcSpec(
    val startDeg: Double,
    val sweepDeg: Double,
    val band: Band,
    val colour: Int,
    /** 1 for a category, 2 for a consumer. */
    val level: Int,
) {
    val endDeg: Double get() = startDeg + sweepDeg
}

/** A radial line that clears the space between two neighbouring arcs. */
data class SeparatorSpec(val angleDeg: Double, val inner: Double, val outer: Double)

data class RingGeometry(
    val diameterDp: Double,
    val twoLevels: Boolean,
    /** The faint track for unused capacity. */
    val track: Band,
    val statusBand: Band,
    val statusSweepDeg: Double,
    val statusColour: Int,
    val arcs: List<ArcSpec>,
    val separators: List<SeparatorSpec>,
)

private const val EPS = 1e-6

private fun usable(value: Double): Boolean = value.isFinite() && value > 0.0

/** Used share of capacity, 0 when the capacity is not positive. Not capped. */
fun usedPercent(ring: PanelRing): Double =
    if (ring.capacity.isFinite() && ring.capacity > 0.0 && ring.used.isFinite()) max(0.0, ring.used) / ring.capacity * 100.0 else 0.0

fun ringGeometry(ring: PanelRing, diameterDp: Double, dark: Boolean): RingGeometry {
    val twoLevels = diameterDp >= ONE_LEVEL_BELOW_DP
    val radiusDp = diameterDp / 2
    val categoryInner = if (twoLevels) CATEGORY_INNER else CATEGORY_INNER_ONE_LEVEL
    val categoryRingOuter = if (twoLevels) CATEGORY_OUTER else OUTER
    val track = Band(categoryInner, OUTER)

    val thickness = max(STATUS_OUTER - STATUS_INNER, STATUS_MIN_THICKNESS_DP / radiusDp)
    val statusBand = Band(STATUS_OUTER - thickness, STATUS_OUTER)

    val hasCapacity = ring.capacity.isFinite() && ring.capacity > 0.0
    val pct = usedPercent(ring)
    val statusSweep = if (hasCapacity) min(1.0, pct / 100.0) * 360.0 else 0.0

    val arcs = mutableListOf<ArcSpec>()
    val separators = mutableListOf<SeparatorSpec>()
    if (hasCapacity) {
        val categoryArcs = mutableListOf<Pair<ArcSpec, Boolean>>()
        val consumerArcs = mutableListOf<ArcSpec>()
        var cursor = 0.0
        for (segment in ring.segments) {
            if (!usable(segment.value)) continue
            val start = min(cursor, 360.0)
            cursor += segment.value / ring.capacity * 360.0
            val end = min(cursor, 360.0)
            if (end - start <= EPS) continue
            val baseCss = categoryColourCss(segment.key, dark)
            val children = segment.children
            val withChildren = twoLevels && children.any { usable(it.value) }
            val band = if (withChildren) Band(categoryInner, categoryRingOuter) else Band(categoryInner, OUTER)
            val category = ArcSpec(start, end - start, band, cssToArgb(baseCss), 1)
            arcs += category
            categoryArcs += category to withChildren
            if (withChildren) {
                var childCursor = start
                children.forEachIndexed { index, child ->
                    if (!usable(child.value)) return@forEachIndexed
                    val childStart = min(childCursor, end)
                    childCursor += child.value / ring.capacity * 360.0
                    val childEnd = min(childCursor, end)
                    if (childEnd - childStart <= EPS) return@forEachIndexed
                    val arc = ArcSpec(childStart, childEnd - childStart, Band(CONSUMER_INNER, OUTER), shade(baseCss, 2, index), 2)
                    arcs += arc
                    consumerArcs += arc
                }
            }
        }
        val categoryMid = Band(categoryInner, categoryRingOuter).mid
        for (i in 0 until categoryArcs.size - 1) {
            val (a, aChildren) = categoryArcs[i]
            val (b, bChildren) = categoryArcs[i + 1]
            if (abs(a.endDeg - b.startDeg) > EPS) continue
            if (arcLengthDp(a, categoryMid, radiusDp) < SEPARATOR_MIN_ARC_DP || arcLengthDp(b, categoryMid, radiusDp) < SEPARATOR_MIN_ARC_DP) continue
            val outer = if (twoLevels && (!aChildren || !bChildren)) OUTER else categoryRingOuter
            separators += SeparatorSpec(a.endDeg, categoryInner, outer)
        }
        val consumerMid = Band(CONSUMER_INNER, OUTER).mid
        for (i in 0 until consumerArcs.size - 1) {
            val a = consumerArcs[i]
            val b = consumerArcs[i + 1]
            if (abs(a.endDeg - b.startDeg) > EPS) continue
            if (arcLengthDp(a, consumerMid, radiusDp) < SEPARATOR_MIN_ARC_DP || arcLengthDp(b, consumerMid, radiusDp) < SEPARATOR_MIN_ARC_DP) continue
            if (separators.any { abs(it.angleDeg - a.endDeg) < EPS && it.outer >= OUTER }) continue
            separators += SeparatorSpec(a.endDeg, CONSUMER_INNER, OUTER)
        }
    }
    return RingGeometry(
        diameterDp = diameterDp,
        twoLevels = twoLevels,
        track = track,
        statusBand = statusBand,
        statusSweepDeg = statusSweep,
        statusColour = statusColourFor(pct),
        arcs = arcs,
        separators = separators,
    )
}

/** Length in dp of the arc on the radius `mid` (a fraction of R). */
fun arcLengthDp(arc: ArcSpec, mid: Double, radiusDp: Double): Double =
    Math.toRadians(arc.sweepDeg) * mid * radiusDp

/**
 * The scale (at most 1) that makes the two centre text lines fit inside a circle of radius
 * [limit]. The lines are stacked and centred. Sizes use any one unit.
 */
fun centreFitScale(topWidth: Double, topHeight: Double, bottomWidth: Double, bottomHeight: Double, gap: Double, limit: Double): Double {
    val halfWidth = max(topWidth, bottomWidth) / 2
    val halfHeight = (topHeight + gap + bottomHeight) / 2
    val corner = Math.hypot(halfWidth, halfHeight)
    if (corner <= 0.0) return 1.0
    return min(1.0, limit / corner)
}
