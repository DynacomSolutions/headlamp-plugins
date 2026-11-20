package app.headlamps

import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/*
 * Port of plugins/usage/src/palette.ts and the colour part of plugins/usage/src/nodes/layout.ts.
 * The functions ending in "Css" return the same text as the TypeScript. The other functions
 * return ARGB integers. This file has no android imports, so JVM tests cover it.
 */

val PALETTE_LIGHT = listOf("#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00", "#6A51A3", "#8A6D3B")
val PALETTE_DARK = listOf("#56B4E9", "#F5B841", "#2FBF9B", "#E59BC4", "#8FD0F5", "#F07F3C", "#B39DDB", "#C9A66B")

private const val GOLDEN_ANGLE = 137.508

/** Same as JavaScript `toFixed`: the exact value of the double, rounded half up. */
private fun toFixed(value: Double, digits: Int): String =
    BigDecimal(value).setScale(digits, RoundingMode.HALF_UP).toPlainString()

/** Colour text (`#rrggbb` or `hsl(...)`) for a palette index. */
fun colourAtCss(index: Int, dark: Boolean): String {
    val base = if (dark) PALETTE_DARK else PALETTE_LIGHT
    if (index < base.size) return base[index]
    val n = index - base.size
    val hue = toFixed((n * GOLDEN_ANGLE + 20) % 360, 2)
    val lightness = (if (dark) intArrayOf(66, 78, 56) else intArrayOf(42, 56, 34))[n % 3]
    return "hsl($hue, 62%, $lightness%)"
}

fun colourAt(index: Int, dark: Boolean): Int = cssToArgb(colourAtCss(index, dark))

private val CATEGORY_SLOT = mapOf("k8s" to 0, "t3" to 1, "herdr" to 2, "other" to 3, "system" to 5)
private val FREE_SLOTS = intArrayOf(4, 6, 7, 8, 9, 10, 11, 12)

/** The colour text of a top-level category. Unknown keys hash to a free slot. */
fun categoryColourCss(key: String, dark: Boolean): String {
    val slot = CATEGORY_SLOT[key]
    if (slot != null) return colourAtCss(slot, dark)
    // JavaScript: h = (h * 31 + charCode) >>> 0, that is unsigned 32-bit arithmetic.
    var h = 0L
    for (ch in key) h = (h * 31 + ch.code) and 0xFFFFFFFFL
    return colourAtCss(FREE_SLOTS[(h % FREE_SLOTS.size).toInt()], dark)
}

fun categoryColour(key: String, dark: Boolean): Int = cssToArgb(categoryColourCss(key, dark))

private data class Hsl(val h: Double, val s: Double, val l: Double)

private val HSL_TEXT = Regex("""^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$""")

private fun toHsl(c: String): Hsl {
    HSL_TEXT.matchEntire(c)?.let { return Hsl(it.groupValues[1].toDouble(), it.groupValues[2].toDouble(), it.groupValues[3].toDouble()) }
    val r = c.substring(1, 3).toInt(16) / 255.0
    val g = c.substring(3, 5).toInt(16) / 255.0
    val b = c.substring(5, 7).toInt(16) / 255.0
    val mx = max(r, max(g, b))
    val mn = min(r, min(g, b))
    val l = (mx + mn) / 2
    val d = mx - mn
    if (d == 0.0) return Hsl(0.0, 0.0, l * 100)
    val s = d / (1 - abs(2 * l - 1))
    val h = when (mx) {
        r -> ((g - b) / d) % 6
        g -> (b - r) / d + 2
        else -> (r - g) / d + 4
    }
    return Hsl((h * 60 + 360) % 360, s * 100, l * 100)
}

/** A shade of [base] for a node at [depth] (1 is the category) and sibling [index]. Colour text. */
fun shadeCss(base: String, depth: Int, index: Int): String {
    val (h, s, l) = toHsl(base)
    val dir = if (l < 50) 1 else -1
    val lightness = min(76.0, max(28.0, l + dir * ((depth - 1) * 7 + (index % 3) * 4)))
    val sat = floor(s + 0.5).toLong()
    return "hsl(${toFixed(h, 2)}, $sat%, ${toFixed(lightness, 1)}%)"
}

fun shade(base: String, depth: Int, index: Int): Int = cssToArgb(shadeCss(base, depth, index))

/** Converts `#rrggbb` or `hsl(h, s%, l%)` text to an opaque ARGB integer. */
fun cssToArgb(css: String): Int {
    if (css.startsWith("#")) return (0xFF000000L or css.substring(1).toLong(16)).toInt()
    val (hDeg, sPct, lPct) = toHsl(css)
    val h = hDeg / 60
    val s = sPct / 100
    val l = lPct / 100
    val c = (1 - abs(2 * l - 1)) * s
    val x = c * (1 - abs((h % 2) - 1))
    val m = l - c / 2
    val rgb = when {
        h < 1 -> doubleArrayOf(c, x, 0.0)
        h < 2 -> doubleArrayOf(x, c, 0.0)
        h < 3 -> doubleArrayOf(0.0, c, x)
        h < 4 -> doubleArrayOf(0.0, x, c)
        h < 5 -> doubleArrayOf(x, 0.0, c)
        else -> doubleArrayOf(c, 0.0, x)
    }
    fun q(v: Double): Int = floor((v + m) * 255 + 0.5).toInt()
    return (0xFF shl 24) or (q(rgb[0]) shl 16) or (q(rgb[1]) shl 8) or q(rgb[2])
}
