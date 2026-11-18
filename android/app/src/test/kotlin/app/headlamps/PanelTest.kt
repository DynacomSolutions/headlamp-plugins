package app.headlamps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PanelTest {
    private fun fixture(name: String): String =
        checkNotNull(javaClass.classLoader!!.getResourceAsStream("fixtures/$name")) { name }
            .bufferedReader().use { it.readText() }

    @Test
    fun parsesPanelListAndIgnoresUnknownFields() {
        val list = AppJson.decodeFromString<PanelList>(fixture("panels.json"))
        assertEquals(listOf("uptime", "usage"), list.panels.map { it.id })
        assertEquals("Up, degraded and down checks.", list.panels[0].description)
        assertEquals("/c/{cluster}/uptime", list.panels[0].link)
        // Missing fields take defaults.
        assertEquals("", list.panels[1].description)
        assertEquals(900, list.panels[1].refreshSeconds)
    }

    @Test
    fun parsesPanelModel() {
        val model = AppJson.decodeFromString<PanelModel>(fixture("panel-uptime.json"))
        assertEquals(PanelStatus.CRIT, model.status)
        assertEquals(2, model.stats.size)
        assertEquals(PanelStatus.CRIT, model.stats[1].status)
        assertEquals(4, model.rows.size)
        assertEquals(0.999, model.rows[0].fraction!!, 1e-9)
        assertNull(model.rows[2].fraction)
        assertEquals(listOf(120.0, 130.5, 110.0), model.series[0].points)
    }

    @Test
    fun unknownStatusReadsAsUnknown() {
        val model = AppJson.decodeFromString<PanelModel>(fixture("panel-uptime.json"))
        assertEquals(PanelStatus.UNKNOWN, model.rows[2].status)
    }

    @Test
    fun missingSeriesAndStatsAreEmpty() {
        val model = AppJson.decodeFromString<PanelModel>("""{"id":"x","title":"X","status":"ok"}""")
        assertTrue(model.stats.isEmpty())
        assertTrue(model.rows.isEmpty())
        assertTrue(model.series.isEmpty())
    }

    @Test
    fun sortsWorstFirstAndKeepsOrderInAGroup() {
        val model = AppJson.decodeFromString<PanelModel>(fixture("panel-uptime.json"))
        assertEquals(
            listOf("b.example.com", "d.example.com", "c.example.com", "a.example.com"),
            sortPanelRows(model.rows).map { it.label },
        )
    }

    @Test
    fun worseStatusPicksTheWorst() {
        assertEquals(PanelStatus.CRIT, worseStatus(PanelStatus.OK, PanelStatus.CRIT))
        assertEquals(PanelStatus.WARN, worseStatus(PanelStatus.WARN, PanelStatus.UNKNOWN))
        assertEquals(PanelStatus.UNKNOWN, worseStatus(PanelStatus.OK, PanelStatus.UNKNOWN))
    }

    @Test
    fun rowLinkFallsBackToPanelLink() {
        val model = AppJson.decodeFromString<PanelModel>(fixture("panel-uptime.json"))
        assertEquals("/c/{cluster}/uptime", rowLink(model.rows[1], model))
        assertEquals("/c/{cluster}/uptime", rowLink(model.rows[0], model))
    }

    @Test
    fun clampsFractionsAbove1() {
        val model = AppJson.decodeFromString<PanelModel>(fixture("panel-uptime.json"))
        assertEquals(1f, barFraction(model.rows[3].fraction!! * 100.0), 0f)
    }

    @Test
    fun buildsAgentUrls() {
        assertEquals(
            "https://h.example.com/clusters/prod-1/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/api/widgets",
            panelsUrl("https://h.example.com/", "prod-1"),
        )
        assertEquals(
            "https://h.example.com/clusters/team%20a%2Fb/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/api/widgets/agent-memory",
            panelUrl("https://h.example.com", "team a/b", "agent-memory"),
        )
    }

    @Test
    fun buildsPanelLinks() {
        assertEquals("https://h.example.com/c/prod-1/uptime", panelLinkUrl("https://h.example.com/", "prod-1", "/c/{cluster}/uptime"))
        assertEquals("https://h.example.com/c/a%20b/uptime", panelLinkUrl("https://h.example.com", "a b", "c/{cluster}/uptime"))
        assertEquals("https://h.example.com", panelLinkUrl("https://h.example.com/", "prod-1", ""))
        assertEquals("https://h.example.com", panelLinkUrl("https://h.example.com/", "prod-1", null))
    }

    @Test
    fun classifiesAgentStatuses() {
        assertEquals(ErrorKind.UNAUTHORIZED, classifyAgent(401))
        assertEquals(ErrorKind.UNAUTHORIZED, classifyAgent(403))
        assertEquals(ErrorKind.AGENT_MISSING, classifyAgent(404, """{"kind":"Status","message":"services not found"}"""))
        assertEquals(ErrorKind.AGENT_MISSING, classifyAgent(503))
        assertEquals(ErrorKind.NOT_FOUND, classifyAgent(404, """{"error":"unknown panel"}"""))
        assertEquals(ErrorKind.PANEL_FAILED, classifyAgent(502, """{"error":"vmalert answered 500"}"""))
        assertEquals(ErrorKind.SERVER, classifyAgent(500))
    }

    @Test
    fun readsErrorDetail() {
        assertEquals("vmalert answered 500", errorDetail("""{"error":"vmalert answered 500"}"""))
        assertEquals("services not found", errorDetail("""{"kind":"Status","message":"services not found"}"""))
        assertNull(errorDetail("not json"))
        assertNull(errorDetail("""{"a":1}"""))
    }

    @Test
    fun panelSnapshotRoundTrips() {
        val model = AppJson.decodeFromString<PanelModel>(fixture("panel-uptime.json"))
        val snapshot = PanelSnapshot(5L, model = model)
        val again = AppJson.decodeFromString<PanelSnapshot>(AppJson.encodeToString(PanelSnapshot.serializer(), snapshot))
        assertEquals(snapshot, again)
    }
}
