package app.headlamps

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Parity with plugins/usage/src/palette.ts and plugins/usage/src/nodes/layout.ts.
 * The expected values come from RUNNING the TypeScript functions, not from hand calculation.
 * They are the colour text and the ARGB value of that text.
 */
class PaletteTest {
    private data class Case(val kind: String, val a: Any, val b: Any, val css: String, val argb: Int)

    private data class ShadeCase(val base: String, val depth: Int, val index: Int, val css: String, val argb: Int)

    private val colourAtCases = listOf(
        Case("colourAt", 0, false, "#0072B2", 0xFF0072B2.toInt()),
        Case("colourAt", 7, false, "#8A6D3B", 0xFF8A6D3B.toInt()),
        Case("colourAt", 8, false, "hsl(20.00, 62%, 42%)", 0xFFAE5529.toInt()),
        Case("colourAt", 9, false, "hsl(157.51, 62%, 56%)", 0xFF49D4A0.toInt()),
        Case("colourAt", 10, false, "hsl(295.02, 62%, 34%)", 0xFF84218C.toInt()),
        Case("colourAt", 20, false, "hsl(230.10, 62%, 42%)", 0xFF293FAE.toInt()),
        Case("colourAt", 0, true, "#56B4E9", 0xFF56B4E9.toInt()),
        Case("colourAt", 7, true, "#C9A66B", 0xFFC9A66B.toInt()),
        Case("colourAt", 8, true, "hsl(20.00, 62%, 66%)", 0xFFDE9673.toInt()),
        Case("colourAt", 9, true, "hsl(157.51, 62%, 78%)", 0xFFA4EAD0.toInt()),
        Case("colourAt", 10, true, "hsl(295.02, 62%, 56%)", 0xFFC949D4.toInt()),
        Case("colourAt", 20, true, "hsl(230.10, 62%, 66%)", 0xFF7384DE.toInt()),
    )

    private val categoryCases = listOf(
        Case("category", "k8s", false, "#0072B2", 0xFF0072B2.toInt()),
        Case("category", "t3", false, "#E69F00", 0xFFE69F00.toInt()),
        Case("category", "herdr", false, "#009E73", 0xFF009E73.toInt()),
        Case("category", "other", false, "#CC79A7", 0xFFCC79A7.toInt()),
        Case("category", "system", false, "#D55E00", 0xFFD55E00.toInt()),
        Case("category", "orchestrator-a", false, "hsl(72.52, 62%, 42%)", 0xFF92AE29.toInt()),
        Case("category", "ci-runner", false, "hsl(210.03, 62%, 56%)", 0xFF498FD4.toInt()),
        Case("category", "claude", false, "hsl(72.52, 62%, 42%)", 0xFF92AE29.toInt()),
        Case("category", "zz", false, "#56B4E9", 0xFF56B4E9.toInt()),
        Case("category", "Ünï", false, "hsl(295.02, 62%, 34%)", 0xFF84218C.toInt()),
        Case("category", "k8s", true, "#56B4E9", 0xFF56B4E9.toInt()),
        Case("category", "t3", true, "#F5B841", 0xFFF5B841.toInt()),
        Case("category", "herdr", true, "#2FBF9B", 0xFF2FBF9B.toInt()),
        Case("category", "other", true, "#E59BC4", 0xFFE59BC4.toInt()),
        Case("category", "system", true, "#F07F3C", 0xFFF07F3C.toInt()),
        Case("category", "orchestrator-a", true, "hsl(72.52, 62%, 66%)", 0xFFC8DE73.toInt()),
        Case("category", "ci-runner", true, "hsl(210.03, 62%, 78%)", 0xFFA4C7EA.toInt()),
        Case("category", "claude", true, "hsl(72.52, 62%, 66%)", 0xFFC8DE73.toInt()),
        Case("category", "zz", true, "#8FD0F5", 0xFF8FD0F5.toInt()),
        Case("category", "Ünï", true, "hsl(295.02, 62%, 56%)", 0xFFC949D4.toInt()),
    )

    private val shadeCases = listOf(
        ShadeCase("#0072B2", 1, 0, "hsl(201.57, 100%, 34.9%)", 0xFF0072B2.toInt()),
        ShadeCase("#0072B2", 1, 1, "hsl(201.57, 100%, 38.9%)", 0xFF007FC6.toInt()),
        ShadeCase("#0072B2", 1, 2, "hsl(201.57, 100%, 42.9%)", 0xFF008CDB.toInt()),
        ShadeCase("#0072B2", 1, 3, "hsl(201.57, 100%, 34.9%)", 0xFF0072B2.toInt()),
        ShadeCase("#0072B2", 2, 0, "hsl(201.57, 100%, 41.9%)", 0xFF0089D6.toInt()),
        ShadeCase("#0072B2", 2, 1, "hsl(201.57, 100%, 45.9%)", 0xFF0096EA.toInt()),
        ShadeCase("#0072B2", 2, 2, "hsl(201.57, 100%, 49.9%)", 0xFF00A3FE.toInt()),
        ShadeCase("#0072B2", 2, 3, "hsl(201.57, 100%, 41.9%)", 0xFF0089D6.toInt()),
        ShadeCase("#56B4E9", 1, 0, "hsl(201.63, 77%, 62.5%)", 0xFF56B4E9.toInt()),
        ShadeCase("#56B4E9", 1, 1, "hsl(201.63, 77%, 58.5%)", 0xFF44ACE7.toInt()),
        ShadeCase("#56B4E9", 1, 2, "hsl(201.63, 77%, 54.5%)", 0xFF32A4E4.toInt()),
        ShadeCase("#56B4E9", 1, 3, "hsl(201.63, 77%, 62.5%)", 0xFF56B4E9.toInt()),
        ShadeCase("#56B4E9", 2, 0, "hsl(201.63, 77%, 55.5%)", 0xFF36A6E5.toInt()),
        ShadeCase("#56B4E9", 2, 1, "hsl(201.63, 77%, 51.5%)", 0xFF249EE3.toInt()),
        ShadeCase("#56B4E9", 2, 2, "hsl(201.63, 77%, 47.5%)", 0xFF1C93D6.toInt()),
        ShadeCase("#56B4E9", 2, 3, "hsl(201.63, 77%, 55.5%)", 0xFF36A6E5.toInt()),
        ShadeCase("hsl(157.51, 62%, 56%)", 1, 0, "hsl(157.51, 62%, 56.0%)", 0xFF49D4A0.toInt()),
        ShadeCase("hsl(157.51, 62%, 56%)", 1, 1, "hsl(157.51, 62%, 52.0%)", 0xFF39D098.toInt()),
        ShadeCase("hsl(157.51, 62%, 56%)", 1, 2, "hsl(157.51, 62%, 48.0%)", 0xFF2FC68D.toInt()),
        ShadeCase("hsl(157.51, 62%, 56%)", 1, 3, "hsl(157.51, 62%, 56.0%)", 0xFF49D4A0.toInt()),
        ShadeCase("hsl(157.51, 62%, 56%)", 2, 0, "hsl(157.51, 62%, 49.0%)", 0xFF2FCA90.toInt()),
        ShadeCase("hsl(157.51, 62%, 56%)", 2, 1, "hsl(157.51, 62%, 45.0%)", 0xFF2CBA85.toInt()),
        ShadeCase("hsl(157.51, 62%, 56%)", 2, 2, "hsl(157.51, 62%, 41.0%)", 0xFF28A979.toInt()),
        ShadeCase("hsl(157.51, 62%, 56%)", 2, 3, "hsl(157.51, 62%, 49.0%)", 0xFF2FCA90.toInt()),
        ShadeCase("hsl(295.02, 62%, 56%)", 1, 0, "hsl(295.02, 62%, 56.0%)", 0xFFC949D4.toInt()),
        ShadeCase("hsl(295.02, 62%, 56%)", 1, 1, "hsl(295.02, 62%, 52.0%)", 0xFFC439D0.toInt()),
        ShadeCase("hsl(295.02, 62%, 56%)", 1, 2, "hsl(295.02, 62%, 48.0%)", 0xFFBA2FC6.toInt()),
        ShadeCase("hsl(295.02, 62%, 56%)", 1, 3, "hsl(295.02, 62%, 56.0%)", 0xFFC949D4.toInt()),
        ShadeCase("hsl(295.02, 62%, 56%)", 2, 0, "hsl(295.02, 62%, 49.0%)", 0xFFBE2FCA.toInt()),
        ShadeCase("hsl(295.02, 62%, 56%)", 2, 1, "hsl(295.02, 62%, 45.0%)", 0xFFAE2CBA.toInt()),
        ShadeCase("hsl(295.02, 62%, 56%)", 2, 2, "hsl(295.02, 62%, 41.0%)", 0xFF9F28A9.toInt()),
        ShadeCase("hsl(295.02, 62%, 56%)", 2, 3, "hsl(295.02, 62%, 49.0%)", 0xFFBE2FCA.toInt()),
        ShadeCase("#2FBF9B", 1, 0, "hsl(165.00, 61%, 46.7%)", 0xFF2EC09B.toInt()),
        ShadeCase("#2FBF9B", 1, 1, "hsl(165.00, 61%, 50.7%)", 0xFF35CEA8.toInt()),
        ShadeCase("#2FBF9B", 1, 2, "hsl(165.00, 61%, 54.7%)", 0xFF45D2AF.toInt()),
        ShadeCase("#2FBF9B", 1, 3, "hsl(165.00, 61%, 46.7%)", 0xFF2EC09B.toInt()),
        ShadeCase("#2FBF9B", 2, 0, "hsl(165.00, 61%, 53.7%)", 0xFF41D1AD.toInt()),
        ShadeCase("#2FBF9B", 2, 1, "hsl(165.00, 61%, 57.7%)", 0xFF51D5B4.toInt()),
        ShadeCase("#2FBF9B", 2, 2, "hsl(165.00, 61%, 61.7%)", 0xFF62D9BB.toInt()),
        ShadeCase("#2FBF9B", 2, 3, "hsl(165.00, 61%, 53.7%)", 0xFF41D1AD.toInt()),
    )

    @Test
    fun colourAtMatchesTypeScript() {
        for (c in colourAtCases) {
            assertEquals("css " + c.a + " " + c.b, c.css, colourAtCss(c.a as Int, c.b as Boolean))
            assertEquals("argb " + c.a + " " + c.b, c.argb, colourAt(c.a as Int, c.b as Boolean))
        }
    }

    @Test
    fun categoryColourMatchesTypeScript() {
        for (c in categoryCases) {
            assertEquals("css " + c.a + " " + c.b, c.css, categoryColourCss(c.a as String, c.b as Boolean))
            assertEquals("argb " + c.a + " " + c.b, c.argb, categoryColour(c.a as String, c.b as Boolean))
        }
    }

    @Test
    fun shadeMatchesTypeScript() {
        for (c in shadeCases) {
            assertEquals("css " + c.base + " " + c.depth + " " + c.index, c.css, shadeCss(c.base, c.depth, c.index))
            assertEquals("argb " + c.base + " " + c.depth + " " + c.index, c.argb, shade(c.base, c.depth, c.index))
        }
    }

    @Test
    fun hashedKeysUseTheFreeSlotsOnly() {
        val fixed = listOf("k8s", "t3", "herdr", "other", "system").map { categoryColourCss(it, false) }
        for (key in listOf("a", "b", "c", "orchestrator-a", "ci-runner", "claude")) {
            assertEquals(false, categoryColourCss(key, false) in fixed)
        }
    }
}
