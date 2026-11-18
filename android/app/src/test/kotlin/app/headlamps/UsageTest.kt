package app.headlamps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageTest {
    private fun fixture(name: String): String =
        checkNotNull(javaClass.classLoader!!.getResourceAsStream("fixtures/$name")) { name }
            .bufferedReader().use { it.readText() }

    @Test
    fun parsesConfig() {
        val config = AppJson.decodeFromString<ConfigResponse>(fixture("config.json"))
        assertEquals(listOf("prod-1", "team a/staging"), config.clusters.map { it.name })
    }

    @Test
    fun parsesMetrics() {
        val list = AppJson.decodeFromString<NodeMetricsList>(fixture("node-metrics.json"))
        assertEquals(3, list.items.size)
        assertEquals("worker-1", list.items[0].metadata.name)
        assertEquals("500m", list.items[0].usage.cpu)
        assertEquals("4Gi", list.items[0].usage.memory)
    }

    @Test
    fun parsesNodes() {
        val list = AppJson.decodeFromString<NodeList>(fixture("nodes.json"))
        assertEquals(3, list.items.size)
        assertEquals("4", list.items[0].status.allocatable.cpu)
        assertEquals("16Gi", list.items[0].status.allocatable.memory)
    }

    @Test
    fun missingFieldsUseDefaults() {
        val list = AppJson.decodeFromString<NodeMetricsList>("""{"items":[{"metadata":{"name":"a"}}]}""")
        assertEquals("", list.items[0].usage.cpu)
    }

    @Test
    fun percentHandlesZeroTotal() {
        assertEquals(0.0, percent(5.0, 0.0), 0.0)
        assertEquals(50.0, percent(1.0, 2.0), 1e-9)
    }

    @Test
    fun barFractionIsClamped() {
        assertEquals(0f, barFraction(-5.0), 0f)
        assertEquals(0.5f, barFraction(50.0), 1e-6f)
        assertEquals(1f, barFraction(159.0), 0f)
        assertEquals(Level.CRITICAL, levelOf(159.0))
    }

    @Test
    fun levelsUseThresholds() {
        assertEquals(Level.NORMAL, levelOf(75.0))
        assertEquals(Level.HIGH, levelOf(75.1))
        assertEquals(Level.HIGH, levelOf(90.0))
        assertEquals(Level.CRITICAL, levelOf(90.1))
    }

    @Test
    fun sortsByWorseOfCpuAndMemory() {
        val sorted = sortNodes(
            listOf(NodeUsage("b", 10.0, 20.0), NodeUsage("a", 80.0, 5.0), NodeUsage("c", 30.0, 60.0), NodeUsage("d", 60.0, 30.0)),
        )
        assertEquals(listOf("a", "c", "d", "b"), sorted.map { it.name })
    }

    @Test
    fun buildsSnapshotFromFixtures() {
        val snapshot = buildSnapshot(
            "prod-1",
            AppJson.decodeFromString(fixture("node-metrics.json")),
            AppJson.decodeFromString(fixture("nodes.json")),
            now = 42L,
        )
        // worker-2: cpu 3.6/4 = 90%, memory 2Gi/4Gi = 50%. worker-3: memory 50%. worker-1: cpu 12.5%, memory 25%.
        assertEquals(listOf("worker-2", "worker-3", "worker-1"), snapshot.nodes.map { it.name })
        assertEquals(90.0, snapshot.nodes[0].cpuPct, 1e-9)
        assertEquals(50.0, snapshot.nodes[0].memPct, 1e-9)
        // cpu: (0.5 + 3.6 + 0.1) / 10, memory: 7Gi / 22Gi.
        assertEquals(42.0, snapshot.cpuPct, 1e-9)
        assertEquals(7.0 / 22.0 * 100, snapshot.memPct, 1e-9)
        assertEquals(42L, snapshot.updatedAt)
    }

    @Test
    fun skipsNodesWithoutCapacity() {
        val metrics = NodeMetricsList(listOf(NodeMetrics(ObjectMeta("x"), ResourceMap("1", "1Gi"))))
        val snapshot = buildSnapshot("c", metrics, NodeList(), 0L)
        assertTrue(snapshot.nodes.isEmpty())
        assertEquals(0.0, snapshot.cpuPct, 0.0)
    }
}
