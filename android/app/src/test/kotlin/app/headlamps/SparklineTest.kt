package app.headlamps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SparklineTest {
    @Test
    fun needsTwoPoints() {
        assertTrue(sparklinePoints(emptyList(), 100f, 20f).isEmpty())
        assertTrue(sparklinePoints(listOf(1.0), 100f, 20f).isEmpty())
    }

    @Test
    fun scalesOldestLeftAndHighestUp() {
        val points = sparklinePoints(listOf(0.0, 10.0, 5.0), 100f, 20f, pad = 0f)
        assertEquals(listOf(0f, 50f, 100f), points.map { it.first })
        assertEquals(20f, points[0].second, 1e-4f)
        assertEquals(0f, points[1].second, 1e-4f)
        assertEquals(10f, points[2].second, 1e-4f)
    }

    @Test
    fun flatSeriesDrawsInTheMiddle() {
        val points = sparklinePoints(listOf(3.0, 3.0, 3.0), 100f, 20f)
        assertTrue(points.all { it.second == 10f })
    }
}
