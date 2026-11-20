package app.headlamps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageLayoutTest {
    private fun layout(w: Double, h: Double) = usageLayout(w, h)

    @Test
    fun realLauncherSizes() {
        data class Expect(val w: Double, val h: Double, val kind: UsageKind, val d: Double, val rows: Int)
        val cases = listOf(
            Expect(145.0, 131.0, UsageKind.SINGLE, 85.0, 0),
            Expect(224.0, 131.0, UsageKind.SIDE, 85.0, 0),
            Expect(303.0, 131.0, UsageKind.SIDE_KEY_BESIDE, 85.0, 4),
            Expect(382.0, 131.0, UsageKind.SIDE_LEGEND_BESIDE, 85.0, 3),
            Expect(145.0, 273.0, UsageKind.STACK, 110.5, 0),
            Expect(224.0, 273.0, UsageKind.SIDE_LEGEND_BELOW, 100.0, 5),
            Expect(303.0, 273.0, UsageKind.SIDE_LEGEND_BELOW, 108.0, 4),
            Expect(382.0, 273.0, UsageKind.SIDE_LEGEND_BELOW, 108.0, 4),
            Expect(110.0, 110.0, UsageKind.SINGLE, 60.0, 0),
            Expect(382.0, 415.0, UsageKind.SIDE_LEGEND_BELOW, 150.0, 9),
        )
        for (c in cases) {
            val l = layout(c.w, c.h)
            assertEquals("${c.w}x${c.h}", c.kind, l.kind)
            assertEquals("${c.w}x${c.h}", c.d, l.diameterDp, 1e-9)
            assertEquals("${c.w}x${c.h}", c.rows, l.legendRows)
        }
    }

    @Test
    fun headerAndUpdatedLine() {
        // The updated line needs width 250 and height 180.
        assertFalse(layout(249.0, 200.0).showUpdated)
        assertFalse(layout(300.0, 179.0).showUpdated)
        assertEquals(26.0, layout(300.0, 131.0).headerDp, 0.0)
        assertTrue(layout(250.0, 180.0).showUpdated)
        assertEquals(40.0, layout(250.0, 200.0).headerDp, 0.0)
        val l = layout(303.0, 273.0)
        assertEquals(287.0, l.contentWidthDp, 1e-9)
        assertEquals(213.0, l.bodyHeightDp, 1e-9)
        assertFalse(layout(382.0, 131.0).showUpdated)
    }

    @Test
    fun legendRowsAlwaysFitTheBody() {
        var w = 190.0
        while (w <= 500.0) {
            var h = 110.0
            while (h <= 600.0) {
                val l = layout(w, h)
                if (l.kind == UsageKind.SIDE_LEGEND_BELOW) {
                    val used = l.diameterDp + CAPTION_DP + LEGEND_HEADER_DP + 4.0 + l.legendRows * LEGEND_ROW_DP
                    assertTrue("$w x $h", l.legendRows >= 2)
                    assertTrue("$w x $h", used <= l.bodyHeightDp + 1e-9)
                }
                if (l.kind == UsageKind.SIDE_LEGEND_BESIDE || l.kind == UsageKind.SIDE_KEY_BESIDE) {
                    assertTrue("$w x $h", l.legendRows * LEGEND_ROW_DP <= l.bodyHeightDp + 1e-9)
                    assertTrue("$w x $h", 2 * l.diameterDp + 8.0 + 12.0 + l.legendWidthDp <= l.contentWidthDp + 1e-9)
                }
                h += 7.0
            }
            w += 9.0
        }
    }

    @Test
    fun legendBesideWidth() {
        val l = layout(382.0, 131.0)
        assertEquals(366.0 - 170.0 - 8.0 - 12.0, l.legendWidthDp, 1e-9)
        val key = layout(303.0, 131.0)
        assertEquals(287.0 - 170.0 - 8.0 - 12.0, key.legendWidthDp, 1e-9)
    }

    @Test
    fun diameterIsNeverBelowFortyDpAndNeverAboveTheCap() {
        var w = 110.0
        while (w <= 500.0) {
            var h = 110.0
            while (h <= 600.0) {
                val l = layout(w, h)
                assertTrue("$w x $h", l.diameterDp >= 40.0)
                assertTrue("$w x $h", l.diameterDp <= 150.0)
                h += 7.0
            }
            w += 9.0
        }
        assertEquals(40.0, layout(110.0, 60.0).diameterDp, 0.0)
    }

    @Test
    fun sideDiametersFitTheirHalf() {
        val l = layout(224.0, 273.0)
        assertTrue(l.diameterDp <= l.halfWidthDp)
        val stack = layout(145.0, 273.0)
        assertTrue(stack.diameterDp * 2 + 6.0 <= stack.bodyHeightDp + 1e-9)
    }

    @Test
    fun onePanelRingShowsOneRing() {
        val l = usageLayout(224.0, 273.0, twoRings = false)
        assertEquals(UsageKind.SINGLE, l.kind)
        assertEquals(150.0.coerceAtMost(l.bodyHeightDp).coerceAtMost(l.contentWidthDp), l.diameterDp, 1e-9)
    }
}
