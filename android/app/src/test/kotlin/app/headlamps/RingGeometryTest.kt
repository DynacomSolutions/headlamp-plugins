package app.headlamps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RingGeometryTest {
    private fun ring(capacity: Double, used: Double, vararg segments: RingSegment) =
        PanelRing(id = "cpu", label = "CPU", unit = "cores", capacity = capacity, used = used, segments = segments.toList())

    private fun seg(key: String, value: Double, vararg children: Double) =
        RingSegment(key, key, value, children.mapIndexed { i, v -> RingSegment("$key/$i", "$key $i", v) })

    private val eps = 1e-6

    @Test
    fun sweepsAreRelativeToCapacityAndStartAtTwelveOClock() {
        val g = ringGeometry(ring(100.0, 50.0, seg("k8s", 30.0), seg("t3", 20.0)), 150.0, false)
        val categories = g.arcs.filter { it.level == 1 }
        assertEquals(2, categories.size)
        assertEquals(0.0, categories[0].startDeg, eps)
        assertEquals(108.0, categories[0].sweepDeg, eps)
        assertEquals(108.0, categories[1].startDeg, eps)
        assertEquals(72.0, categories[1].sweepDeg, eps)
        assertEquals(categoryColour("k8s", false), categories[0].colour)
        assertEquals(categoryColour("t3", false), categories[1].colour)
    }

    @Test
    fun darkModeUsesTheDarkPalette() {
        val g = ringGeometry(ring(100.0, 30.0, seg("k8s", 30.0)), 150.0, true)
        assertEquals(categoryColour("k8s", true), g.arcs.single().colour)
    }

    @Test
    fun childrenLieInsideTheirParentAndLeaveTheRestEmpty() {
        val g = ringGeometry(ring(100.0, 50.0, seg("k8s", 30.0, 10.0, 10.0), seg("t3", 20.0, 20.0)), 150.0, false)
        val children = g.arcs.filter { it.level == 2 }
        assertEquals(3, children.size)
        assertEquals(0.0, children[0].startDeg, eps)
        assertEquals(36.0, children[0].sweepDeg, eps)
        assertEquals(36.0, children[1].startDeg, eps)
        assertEquals(36.0, children[1].sweepDeg, eps)
        // The parent ends at 108 degrees. The children end at 72, so 72 to 108 stays empty.
        assertEquals(72.0, children[1].endDeg, eps)
        assertEquals(108.0, children[2].startDeg, eps)
        assertEquals(72.0, children[2].sweepDeg, eps)
        val parent = g.arcs.first { it.level == 1 }
        assertTrue(children[1].endDeg <= parent.endDeg + eps)
        assertEquals(shade(categoryColourCss("k8s", false), 2, 0), children[0].colour)
        assertEquals(shade(categoryColourCss("k8s", false), 2, 1), children[1].colour)
        assertEquals(shade(categoryColourCss("t3", false), 2, 0), children[2].colour)
    }

    @Test
    fun childrenAreClippedToTheirParent() {
        val g = ringGeometry(ring(100.0, 30.0, seg("k8s", 30.0, 20.0, 20.0)), 150.0, false)
        val parent = g.arcs.first { it.level == 1 }
        val children = g.arcs.filter { it.level == 2 }
        assertEquals(2, children.size)
        assertEquals(parent.endDeg, children[1].endDeg, eps)
    }

    @Test
    fun categoryWithoutChildrenSpansBothRings() {
        val g = ringGeometry(ring(100.0, 50.0, seg("k8s", 30.0, 10.0), seg("system", 20.0)), 150.0, false)
        val k8s = g.arcs.first { it.level == 1 && it.startDeg == 0.0 }
        val system = g.arcs.first { it.level == 1 && it.startDeg > 0.0 }
        assertEquals(Band(0.60, 0.79), k8s.band)
        assertEquals(Band(0.60, 1.0), system.band)
        assertEquals(1, g.arcs.count { it.level == 2 })
        assertEquals(Band(0.805, 1.0), g.arcs.first { it.level == 2 }.band)
    }

    @Test
    fun overOneHundredPercentIsCapped() {
        val g = ringGeometry(ring(100.0, 150.0, seg("k8s", 90.0), seg("t3", 60.0), seg("system", 10.0)), 150.0, false)
        assertEquals(360.0, g.statusSweepDeg, eps)
        assertEquals(2, g.arcs.size)
        assertEquals(360.0, g.arcs.last().endDeg, eps)
        assertTrue(g.arcs.all { it.endDeg <= 360.0 + eps })
        assertEquals(STATUS_CRITICAL, g.statusColour)
    }

    @Test
    fun capacityZeroDrawsNoArcs() {
        val g = ringGeometry(ring(0.0, 5.0, seg("k8s", 5.0, 2.0)), 150.0, false)
        assertTrue(g.arcs.isEmpty())
        assertTrue(g.separators.isEmpty())
        assertEquals(0.0, g.statusSweepDeg, eps)
        assertEquals("-", usedPercentText(ring(0.0, 5.0)))
    }

    @Test
    fun oneLevelBelowSeventySixDp() {
        val small = ringGeometry(ring(100.0, 50.0, seg("k8s", 30.0, 10.0), seg("t3", 20.0)), 75.9, false)
        assertFalse(small.twoLevels)
        assertTrue(small.arcs.all { it.level == 1 })
        assertEquals(2, small.arcs.size)
        assertTrue(small.arcs.all { it.band == Band(0.62, 1.0) })
        assertEquals(Band(0.62, 1.0), small.track)
        val big = ringGeometry(ring(100.0, 50.0, seg("k8s", 30.0, 10.0), seg("t3", 20.0)), 76.0, false)
        assertTrue(big.twoLevels)
        assertTrue(big.arcs.any { it.level == 2 })
        assertEquals(Band(0.60, 1.0), big.track)
    }

    @Test
    fun statusRingFollowsTheStatusColours() {
        fun colour(used: Double) = ringGeometry(ring(100.0, used, seg("k8s", used)), 150.0, false).statusColour
        assertEquals(STATUS_OK, colour(75.0))
        assertEquals(STATUS_HIGH, colour(76.0))
        assertEquals(STATUS_HIGH, colour(90.0))
        assertEquals(STATUS_CRITICAL, colour(91.0))
        assertEquals(180.0, ringGeometry(ring(100.0, 50.0), 150.0, false).statusSweepDeg, eps)
    }

    @Test
    fun statusRingIsNeverThinnerThanTwoAndAHalfDp() {
        val big = ringGeometry(ring(100.0, 50.0), 150.0, false).statusBand
        assertEquals(0.56, big.outer, eps)
        assertEquals(0.50, big.inner, eps)
        val small = ringGeometry(ring(100.0, 50.0), 50.0, false).statusBand
        assertEquals(0.56, small.outer, eps)
        assertEquals(2.5, (small.outer - small.inner) * 25.0, 1e-9)
        assertTrue(small.inner < 0.50)
    }

    @Test
    fun separatorsOnlyBetweenLongArcs() {
        // Radius 75 dp. A category ring arc at 0.695 R is 52 dp long per radian.
        // 0.5 % of the circle is 1.8 degrees, that is 1.6 dp: too short.
        val g = ringGeometry(ring(100.0, 40.5, seg("k8s", 20.0, 10.0), seg("t3", 0.5), seg("system", 20.0, 10.0)), 150.0, false)
        val categoryAngles = g.separators.filter { it.inner == 0.60 }.map { it.angleDeg }
        // k8s | t3 and t3 | system both touch the short arc: no separator.
        assertTrue(categoryAngles.isEmpty())
        val longer = ringGeometry(ring(100.0, 60.0, seg("k8s", 20.0, 10.0), seg("t3", 20.0), seg("system", 20.0, 10.0)), 150.0, false)
        val angles = longer.separators.filter { it.inner == 0.60 }.map { it.angleDeg }
        assertEquals(listOf(72.0, 144.0), angles)
    }

    @Test
    fun separatorOfAChildlessNeighbourReachesTheOuterEdge() {
        val g = ringGeometry(ring(100.0, 40.0, seg("k8s", 20.0, 10.0), seg("system", 20.0)), 150.0, false)
        val s = g.separators.single { it.inner == 0.60 }
        assertEquals(1.0, s.outer, eps)
        val both = ringGeometry(ring(100.0, 40.0, seg("k8s", 20.0, 10.0), seg("t3", 20.0, 10.0)), 150.0, false)
        assertEquals(0.79, both.separators.single { it.inner == 0.60 }.outer, eps)
    }

    @Test
    fun consumerSeparatorsOnlyBetweenTouchingChildren() {
        // The children touch at 36 degrees. The last child of k8s touches the first child of t3 at 72.
        val touching = ringGeometry(ring(100.0, 40.0, seg("k8s", 20.0, 10.0, 10.0), seg("t3", 20.0, 10.0)), 150.0, false)
        assertEquals(listOf(36.0, 72.0), touching.separators.filter { it.inner == 0.805 }.map { it.angleDeg })
        // The second child ends at 54 degrees, so it does not touch the child of t3 at 72.
        val gap = ringGeometry(ring(100.0, 35.0, seg("k8s", 20.0, 10.0, 5.0), seg("t3", 20.0, 10.0)), 150.0, false)
        assertEquals(listOf(36.0), gap.separators.filter { it.inner == 0.805 }.map { it.angleDeg })
    }

    @Test
    fun noSeparatorWhenThereIsOnlyOneArc() {
        val g = ringGeometry(ring(100.0, 100.0, seg("k8s", 100.0)), 150.0, false)
        assertTrue(g.separators.isEmpty())
    }

    @Test
    fun anglesStayExactWhenArcsAreTiny() {
        val g = ringGeometry(ring(1000.0, 1.0, seg("k8s", 0.5), seg("t3", 0.5)), 150.0, false)
        assertEquals(0.18, g.arcs[0].sweepDeg, eps)
        assertEquals(0.18, g.arcs[1].startDeg, eps)
    }

    @Test
    fun centreTextShrinksOnlyWhenNeeded() {
        assertEquals(1.0, centreFitScale(10.0, 5.0, 8.0, 3.0, 1.0, 40.0), eps)
        val scale = centreFitScale(60.0, 30.0, 40.0, 20.0, 4.0, 40.0)
        assertTrue(scale < 1.0)
        // After scaling, the farthest corner touches the limit.
        val corner = Math.hypot(60.0 * scale / 2, (30.0 + 4.0 + 20.0) * scale / 2)
        assertEquals(40.0, corner, 1e-9)
    }
}
