package app.headlamps

import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class UrlsErrorsTest {
    @Test
    fun trimsTrailingSlashes() {
        assertEquals("https://h.example.com/config", configUrl("https://h.example.com/"))
        assertEquals("https://h.example.com/config", configUrl(" https://h.example.com// "))
        assertEquals("https://h.example.com/sub/config", configUrl("https://h.example.com/sub/"))
    }

    @Test
    fun buildsApiUrls() {
        assertEquals(
            "https://h.example.com/clusters/prod-1/apis/metrics.k8s.io/v1beta1/nodes",
            metricsUrl("https://h.example.com/", "prod-1"),
        )
        assertEquals("https://h.example.com/clusters/prod-1/api/v1/nodes", nodesUrl("https://h.example.com", "prod-1"))
        assertEquals("https://h.example.com/c/prod-1/usage/nodes", usagePageUrl("https://h.example.com/", "prod-1"))
    }

    @Test
    fun encodesClusterNames() {
        assertEquals("http://h.example.com:4466/clusters/team%20a%2Fstaging/api/v1/nodes", nodesUrl("http://h.example.com:4466/", "team a/staging"))
        assertEquals("https://h.example.com/c/a%3Fb%23c/usage/nodes", usagePageUrl("https://h.example.com", "a?b#c"))
    }

    @Test
    fun detectsCleartext() {
        assertTrue(isCleartext("http://h.example.com"))
        assertTrue(isCleartext(" HTTP://h.example.com"))
        assertFalse(isCleartext("https://h.example.com"))
    }

    @Test
    fun classifiesStatuses() {
        assertEquals(ErrorKind.UNAUTHORIZED, classifyHttp(401, metrics = true))
        assertEquals(ErrorKind.UNAUTHORIZED, classifyHttp(403, metrics = false))
        assertEquals(ErrorKind.METRICS_MISSING, classifyHttp(404, metrics = true))
        assertEquals(ErrorKind.METRICS_MISSING, classifyHttp(503, metrics = true))
        assertEquals(ErrorKind.NOT_FOUND, classifyHttp(404, metrics = false))
        assertEquals(ErrorKind.SERVER, classifyHttp(500, metrics = true))
    }

    @Test
    fun classifiesThrowables() {
        assertEquals(ErrorKind.UNREACHABLE, classify(IOException("timeout")))
        assertEquals(ErrorKind.BAD_RESPONSE, classify(SerializationException("bad")))
        assertEquals(ErrorKind.INVALID_URL, classify(IllegalArgumentException("bad url")))
        assertEquals(ErrorKind.UNAUTHORIZED, classify(FetchException(ErrorKind.UNAUTHORIZED, 401)))
    }

    @Test
    fun missingInstanceHasOwnText() {
        assertEquals(R.string.error_instance_missing, errorText(ErrorKind.INSTANCE_MISSING))
        assertEquals(R.string.error_agent_missing, panelErrorText(ErrorKind.AGENT_MISSING))
        assertEquals(R.string.error_unauthorised, panelErrorText(ErrorKind.UNAUTHORIZED))
    }
}
