package app.headlamps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QuantityTest {
    private fun check(expected: Double, text: String) {
        val actual = parseQuantity(text)
        assertEquals(text, expected, actual ?: Double.NaN, Math.abs(expected) * 1e-12 + 1e-15)
    }

    @Test
    fun plainNumbers() {
        check(4.0, "4")
        check(0.0, "0")
        check(1.5, "1.5")
        check(0.25, ".25")
        check(2.0, "2.")
    }

    @Test
    fun smallSuffixes() {
        check(0.5, "500m")
        check(1e-6 * 250, "250u")
        check(3.6, "3600000000n")
    }

    @Test
    fun decimalSuffixes() {
        check(1e3, "1k")
        check(2e6, "2M")
        check(1.5e9, "1.5G")
        check(3e12, "3T")
        check(1e15, "1P")
        check(1e18, "1E")
    }

    @Test
    fun binarySuffixes() {
        check(1024.0, "1Ki")
        check(1024.0 * 1024, "1Mi")
        check(16.0 * 1024 * 1024 * 1024, "16Gi")
        check(1024.0 * 1024 * 1024 * 1024, "1Ti")
        check(0.5 * 1024 * 1024 * 1024, "0.5Gi")
    }

    @Test
    fun exponentForms() {
        check(1000.0, "1e3")
        check(12e6, "12E6")
        check(0.015, "1.5e-2")
        check(1e18, "1E")
    }

    @Test
    fun invalidInput() {
        assertNull(parseQuantity(null))
        assertNull(parseQuantity(""))
        assertNull(parseQuantity("abc"))
        assertNull(parseQuantity("12Xi"))
        assertNull(parseQuantity("1e"))
        assertNull(parseQuantity("1 Gi"))
    }

    @Test
    fun trimsWhitespace() = check(2.0, " 2 ")
}
