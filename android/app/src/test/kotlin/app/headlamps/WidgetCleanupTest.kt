package app.headlamps

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetCleanupTest {
    private val scope = CoroutineScope(Dispatchers.Default)

    @Test
    fun runsTheBlockAndFinishesOnce() = runBlocking {
        val order = mutableListOf<String>()
        scope.launchCleanup(finish = { order += "finish" }) { order += "block" }.join()
        assertEquals(listOf("block", "finish"), order)
    }

    @Test
    fun runsTheBlockWhenThereIsNoPendingResult() = runBlocking {
        var ran = false
        scope.launchCleanup(finish = null) { ran = true }.join()
        assertTrue(ran)
    }

    @Test
    fun finishesAndDoesNotThrowWhenTheBlockThrows() = runBlocking {
        var finished = 0
        val errors = mutableListOf<Throwable>()
        scope.launchCleanup(finish = { finished++ }, onError = { errors += it }) {
            error("store failed")
        }.join()
        assertEquals(1, finished)
        assertEquals(listOf("store failed"), errors.map { it.message })
    }

    @Test
    fun doesNotThrowWhenTheBlockThrowsAndThereIsNoPendingResult() = runBlocking {
        scope.launchCleanup(finish = null) { error("store failed") }.join()
    }
}
