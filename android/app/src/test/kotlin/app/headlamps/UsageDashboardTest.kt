package app.headlamps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageDashboardTest {
    private fun fixture(name: String): String =
        checkNotNull(javaClass.classLoader!!.getResourceAsStream("fixtures/$name")) { name }
            .bufferedReader().use { it.readText() }

    private val model get() = AppJson.decodeFromString<PanelModel>(fixture("panel-usage-dashboard.json"))
    private val cpu get() = model.rings.first { it.id == "cpu" }
    private val memory get() = model.rings.first { it.id == "memory" }

    @Test
    fun decodesRingsFromTheFixture() {
        val m = model
        assertEquals("usage-dashboard", m.id)
        assertEquals(PanelStatus.WARN, m.status)
        assertEquals(listOf("cpu", "memory"), m.rings.map { it.id })
        assertEquals("cores", cpu.unit)
        assertEquals(96.0, cpu.capacity, 0.0)
        assertEquals(51.02, cpu.used, 0.0)
        assertEquals(listOf("k8s", "t3", "system"), cpu.segments.map { it.key })
        assertEquals(8, cpu.segments[0].children.size)
        assertEquals("k8s/ns:shop", cpu.segments[0].children[0].key)
        assertEquals(412316860416.0, memory.capacity, 0.0)
        assertEquals("bytes", memory.unit)
    }

    @Test
    fun categoriesSumToUsedAndChildrenStayInsideTheirParent() {
        for (ring in model.rings) {
            assertEquals(ring.used, ring.segments.sumOf { it.value }, ring.used * 1e-9)
            for (segment in ring.segments) {
                assertTrue(segment.children.sumOf { it.value } <= segment.value)
            }
        }
    }

    @Test
    fun anOldPanelHasNoRings() {
        val old = AppJson.decodeFromString<PanelModel>(fixture("panel-uptime.json"))
        assertTrue(old.rings.isEmpty())
        val bare = AppJson.decodeFromString<PanelModel>("""{"id":"usage-dashboard","rings":[{"id":"cpu","segments":[{"key":"k8s","value":1.5}]}]}""")
        assertEquals(0.0, bare.rings[0].capacity, 0.0)
        assertTrue(bare.rings[0].segments[0].children.isEmpty())
    }

    @Test
    fun geometryOfTheFixtureFillsNoMoreThanTheCircle() {
        for (ring in model.rings) {
            val g = ringGeometry(ring, 150.0, false)
            assertEquals(ring.segments.size, g.arcs.count { it.level == 1 })
            assertEquals(ring.segments.sumOf { it.children.size }, g.arcs.count { it.level == 2 })
            assertEquals(ring.used / ring.capacity * 360.0, g.arcs.filter { it.level == 1 }.last().endDeg, 1e-6)
        }
    }

    private fun ring(id: String, capacity: Double, vararg segments: RingSegment) =
        PanelRing(id, id, "cores", capacity, segments.sumOf { it.value }, segments.toList())

    private fun child(key: String, value: Double) = RingSegment(key, key.substringAfterLast('/'), value)

    @Test
    fun combinedLegendOfTheFixture() {
        val entries = combinedLegend(cpu, memory)
        assertEquals(17, entries.size)
        assertEquals(listOf("Kubernetes", "T3 Code", "System"), entries.take(3).map { it.name })
        assertTrue(entries.take(3).all { it.category })
        assertTrue(entries.drop(3).none { it.category })
        assertEquals(listOf("Shop", "web-shop", "Databases"), entries.drop(3).take(3).map { it.name })
        assertEquals(categoryColour("k8s", false), entries[0].lightColour)
        assertEquals(categoryColour("k8s", true), entries[0].darkColour)
        assertEquals("32%", entries[0].cpuText)
        assertEquals("46%", entries[0].memText)
        val shop = entries[3]
        assertEquals("12%", shop.cpuText)
        assertEquals("15%", shop.memText)
        assertEquals(shade(categoryColourCss("k8s", false), 2, 0), shop.lightColour)
        // Children are sorted by the higher share.
        val children = entries.drop(3)
        val best = children.map { maxOf(it.cpuText.trimEnd('%').toIntOrNull() ?: 0, it.memText.trimEnd('%').toIntOrNull() ?: 0) }
        assertEquals(best.sortedDescending(), best)
    }

    @Test
    fun combinedLegendUsesTheHigherShareForOrderAndColour() {
        // "b" is bigger in CPU at index 1. "a" is bigger in memory at index 1.
        val cpu = ring("cpu", 100.0, RingSegment("k8s", "Kubernetes", 30.0, listOf(child("k8s/a", 5.0), child("k8s/b", 20.0))))
        val mem = ring("memory", 200.0, RingSegment("k8s", "Kubernetes", 100.0, listOf(child("k8s/b", 10.0), child("k8s/a", 80.0))))
        val entries = combinedLegend(cpu, mem)
        assertEquals(listOf("k8s", "a", "b"), entries.map { it.key.substringAfterLast('/') })
        val a = entries[1]
        val b = entries[2]
        // a: 5% in CPU (index 0), 40% in memory (index 1). Memory wins.
        assertEquals(shade(categoryColourCss("k8s", false), 2, 1), a.lightColour)
        assertEquals(shade(categoryColourCss("k8s", true), 2, 1), a.darkColour)
        assertEquals("5%", a.cpuText)
        assertEquals("40%", a.memText)
        // b: 20% in CPU (index 1), 5% in memory (index 0). CPU wins.
        assertEquals(shade(categoryColourCss("k8s", false), 2, 1), b.lightColour)
        assertEquals("20%", b.cpuText)
        assertEquals("5%", b.memText)
    }

    @Test
    fun combinedLegendKeepsACategoryWithoutChildrenOnce() {
        val cpu = ring("cpu", 10.0, RingSegment("system", "System", 3.0), RingSegment("k8s", "Kubernetes", 2.0, listOf(child("k8s/x", 1.0))))
        val mem = ring("memory", 10.0, RingSegment("k8s", "Kubernetes", 4.0))
        val entries = combinedLegend(cpu, mem)
        assertEquals(listOf("k8s", "system", "k8s/x"), entries.map { it.key })
        assertEquals(3, entries.size)
        val system = entries.first { it.key == "system" }
        assertEquals("30%", system.cpuText)
        assertEquals("-", system.memText)
        assertEquals(categoryColour("system", false), system.lightColour)
        assertEquals("10%", entries.first { it.key == "k8s/x" }.cpuText)
        assertEquals("-", entries.first { it.key == "k8s/x" }.memText)
    }

    @Test
    fun combinedLegendShowsBelowOnePercentAndSkipsEmptyRings() {
        val cpu = ring("cpu", 1000.0, RingSegment("k8s", "Kubernetes", 4.0, listOf(child("k8s/tiny", 4.0))))
        val empty = ring("memory", 0.0, RingSegment("k8s", "Kubernetes", 4.0))
        val entries = combinedLegend(cpu, empty)
        assertEquals("<1%", entries[1].cpuText)
        assertEquals("-", entries[0].memText)
    }

    @Test
    fun combinedLegendHasAtMostFortyEntries() {
        val cpu = ring("cpu", 5000.0, *(1..60).map { RingSegment("k$it", "n$it", it.toDouble()) }.toTypedArray())
        val entries = combinedLegend(cpu, ring("memory", 100.0))
        assertEquals(40, entries.size)
        assertEquals("n60", entries[0].name)
    }

    @Test
    fun textHelpers() {
        assertEquals("53%", usedPercentText(cpu))
        assertEquals("81%", usedPercentText(memory))
        assertEquals("51 of 96 cores", quantityText(cpu))
        assertEquals("313 of 384 GiB", quantityText(memory))
        assertEquals("CPU 51 of 96 cores", captionText("CPU", cpu))
        assertEquals("Mem 313 of 384 GiB", captionText("Mem", memory))
        assertEquals("2.5", compactNumber(2.5))
        assertEquals("9.0", compactNumber(9.0))
        assertEquals("10", compactNumber(9.96))
        assertEquals("10", compactNumber(10.4))
        assertEquals("2.5 of 4.0 cores", quantityText(PanelRing("cpu", "CPU", "cores", 4.0, 2.5)))
        assertEquals("<1%", shareText(0.49, 100.0))
        assertEquals("1%", shareText(0.5, 100.0))
        assertEquals("100%", shareText(100.0, 100.0))
        assertEquals("-", shareText(1.0, 0.0))
    }

    @Test
    fun descriptionNamesTheBiggestArcs() {
        assertEquals("CPU 53% of 96 cores. Kubernetes 32%, T3 Code 13%, System 9%", ringDescription("CPU", cpu))
    }

    @Test
    fun theWorseResourceWinsAndTiesGoToCpu() {
        assertEquals("memory", worseRing(cpu, memory).id)
        val high = PanelRing("cpu", "CPU", "cores", 10.0, 9.0)
        val low = PanelRing("memory", "Memory", "bytes", 10.0, 2.0)
        assertEquals("cpu", worseRing(high, low).id)
        val tie = PanelRing("memory", "Memory", "bytes", 20.0, 18.0)
        assertEquals("cpu", worseRing(high, tie).id)
    }
}
