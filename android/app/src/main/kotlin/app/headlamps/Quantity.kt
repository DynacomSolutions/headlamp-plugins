package app.headlamps

import java.math.BigDecimal

private val NUMBER = Regex("""^([+-]?(?:\d+\.?\d*|\.\d+))(.*)$""")
private val EXPONENT = Regex("""^[eE][+-]?\d+$""")

private val SUFFIX = mapOf(
    "n" to 1e-9, "u" to 1e-6, "m" to 1e-3, "" to 1.0,
    "k" to 1e3, "M" to 1e6, "G" to 1e9, "T" to 1e12, "P" to 1e15, "E" to 1e18,
    "Ki" to 1024.0, "Mi" to 1024.0 * 1024, "Gi" to 1024.0 * 1024 * 1024,
    "Ti" to 1024.0 * 1024 * 1024 * 1024,
    "Pi" to 1024.0 * 1024 * 1024 * 1024 * 1024,
    "Ei" to 1024.0 * 1024 * 1024 * 1024 * 1024 * 1024,
)

/**
 * Parses a Kubernetes quantity such as "250m", "16Gi", "1e3" or "1.5G".
 * Returns the value in base units (cores or bytes), or null if the text is not valid.
 */
fun parseQuantity(text: String?): Double? {
    val match = NUMBER.matchEntire(text?.trim().orEmpty()) ?: return null
    val number = match.groupValues[1].toBigDecimalOrNull() ?: return null
    val rest = match.groupValues[2]
    if (EXPONENT.matches(rest)) {
        return (number.toString() + rest).toBigDecimalOrNull()?.toDouble()
    }
    val factor = SUFFIX[rest] ?: return null
    return number.multiply(BigDecimal.valueOf(factor)).toDouble()
}
