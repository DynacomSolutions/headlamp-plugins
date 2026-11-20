package app.headlamps

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** Which arrangement the widget uses at its exact size. */
enum class UsageKind {
    /** CPU left, memory right, captions, a header row and a scrolling combined legend below. */
    SIDE_LEGEND_BELOW,

    /** Both rings in one row, then the combined legend (names and two value columns) beside them. */
    SIDE_LEGEND_BESIDE,

    /** Both rings in one row, then a key (dot and name only) beside them. */
    SIDE_KEY_BESIDE,

    /** CPU left, memory right, nothing else. */
    SIDE,

    /** CPU above memory. */
    STACK,

    /** The worse resource as one ring, the other one as a small bar. */
    SINGLE,
}

/** Everything the composable needs, in dp. It needs no more arithmetic. */
data class UsageLayout(
    val kind: UsageKind,
    val showUpdated: Boolean,
    val headerDp: Double,
    val contentWidthDp: Double,
    val bodyHeightDp: Double,
    val diameterDp: Double,
    /** Width of one half in the side kinds. */
    val halfWidthDp: Double,
    /** Rows of the legend or key, each [LEGEND_ROW_DP] high. */
    val legendRows: Int,
    /** Width of the legend or key beside the rings. */
    val legendWidthDp: Double,
)

const val USAGE_PADDING_DP = 8.0
const val USAGE_GAP_DP = 8.0
const val USAGE_MIN_DIAMETER_DP = 40.0
const val USAGE_MAX_DIAMETER_DP = 150.0
const val LEGEND_ROW_DP = 18.0
const val LEGEND_HEADER_DP = 14.0
const val CAPTION_DP = 15.0
const val LEGEND_VALUE_DP = 38.0
const val RING_GAP_BESIDE_DP = 8.0
const val LEGEND_GAP_BESIDE_DP = 12.0
private const val UPDATED_MIN_WIDTH_DP = 250.0
private const val UPDATED_MIN_HEIGHT_DP = 180.0
private const val HEADER_DP = 26.0
private const val HEADER_UPDATED_DP = 40.0
private const val HEADER_GAP_DP = 4.0
private const val SIDE_MIN_CONTENT_DP = 190.0
private const val STACK_MIN_BODY_DP = 190.0
private const val LEGEND_BELOW_MIN_BODY_DP = 150.0
private const val LEGEND_BESIDE_FREE_DP = 162.0
private const val KEY_BESIDE_FREE_DP = 96.0
private const val BELOW_GAP_DP = 4.0
private const val SINGLE_COLUMN_DP = 34.0
private const val STACK_GAP_DP = 6.0

/**
 * Decides the arrangement from the exact widget size. When [twoRings] is false the panel has
 * only one ring, and the widget shows that ring alone.
 */
fun usageLayout(widthDp: Double, heightDp: Double, twoRings: Boolean = true): UsageLayout {
    val showUpdated = widthDp >= UPDATED_MIN_WIDTH_DP && heightDp >= UPDATED_MIN_HEIGHT_DP
    val header = if (showUpdated) HEADER_UPDATED_DP else HEADER_DP
    val contentW = widthDp - 2 * USAGE_PADDING_DP
    val bodyH = heightDp - 2 * USAGE_PADDING_DP - header - HEADER_GAP_DP
    val half = (contentW - USAGE_GAP_DP) / 2

    fun result(kind: UsageKind, d: Double, legendRows: Int = 0, legendWidth: Double = 0.0) = UsageLayout(
        kind = kind,
        showUpdated = showUpdated,
        headerDp = header,
        contentWidthDp = contentW,
        bodyHeightDp = bodyH,
        diameterDp = max(USAGE_MIN_DIAMETER_DP, d),
        halfWidthDp = half,
        legendRows = legendRows,
        legendWidthDp = legendWidth,
    )

    if (!twoRings) return result(UsageKind.SINGLE, min(min(bodyH, contentW), USAGE_MAX_DIAMETER_DP))
    if (contentW >= SIDE_MIN_CONTENT_DP) {
        val dMax = min(half, USAGE_MAX_DIAMETER_DP)
        if (bodyH >= LEGEND_BELOW_MIN_BODY_DP) {
            val fixed = CAPTION_DP + LEGEND_HEADER_DP + BELOW_GAP_DP
            val d0 = min(dMax, bodyH * 0.48)
            val rows = floor((bodyH - d0 - fixed) / LEGEND_ROW_DP).toInt()
            if (rows >= 2) {
                return result(UsageKind.SIDE_LEGEND_BELOW, min(dMax, bodyH - fixed - rows * LEGEND_ROW_DP), rows)
            }
        }
        val d = max(USAGE_MIN_DIAMETER_DP, min(dMax, bodyH))
        val free = contentW - 2 * d - RING_GAP_BESIDE_DP
        val legendWidth = free - LEGEND_GAP_BESIDE_DP
        if (free >= LEGEND_BESIDE_FREE_DP) {
            return result(UsageKind.SIDE_LEGEND_BESIDE, d, max(1, floor((bodyH - LEGEND_HEADER_DP) / LEGEND_ROW_DP).toInt()), legendWidth)
        }
        if (free >= KEY_BESIDE_FREE_DP) {
            return result(UsageKind.SIDE_KEY_BESIDE, d, max(1, floor(bodyH / LEGEND_ROW_DP).toInt()), legendWidth)
        }
        return result(UsageKind.SIDE, d)
    }
    if (bodyH >= STACK_MIN_BODY_DP) {
        return result(UsageKind.STACK, minOf(contentW, (bodyH - STACK_GAP_DP) / 2, USAGE_MAX_DIAMETER_DP))
    }
    return result(UsageKind.SINGLE, min(bodyH, contentW - SINGLE_COLUMN_DP))
}
