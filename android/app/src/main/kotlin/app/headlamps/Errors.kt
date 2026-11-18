package app.headlamps

import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import java.io.IOException

@Serializable
enum class ErrorKind { UNREACHABLE, UNAUTHORIZED, METRICS_MISSING, NOT_FOUND, SERVER, BAD_RESPONSE, INVALID_URL, INSTANCE_MISSING, AGENT_MISSING, PANEL_FAILED }

class FetchException(val kind: ErrorKind, val code: Int? = null, cause: Throwable? = null, val detail: String? = null) :
    Exception("Fetch failed: $kind", cause)

/** Maps an HTTP status to an error kind. [metrics] is true for the metrics endpoint. */
fun classifyHttp(code: Int, metrics: Boolean): ErrorKind = when {
    code == 401 || code == 403 -> ErrorKind.UNAUTHORIZED
    code == 503 -> ErrorKind.METRICS_MISSING
    code == 404 -> if (metrics) ErrorKind.METRICS_MISSING else ErrorKind.NOT_FOUND
    else -> ErrorKind.SERVER
}

/**
 * Maps an HTTP status from the headlamp-agent proxy to an error kind.
 * 404 or 503 from the proxy means the agent is not installed or not running.
 * 404 with "unknown panel" in the body means the panel id is wrong.
 * 502 means the panel's data source failed.
 */
fun classifyAgent(code: Int, body: String = ""): ErrorKind = when {
    code == 401 || code == 403 -> ErrorKind.UNAUTHORIZED
    code == 404 && body.contains("unknown panel") -> ErrorKind.NOT_FOUND
    code == 404 || code == 503 -> ErrorKind.AGENT_MISSING
    code == 502 -> ErrorKind.PANEL_FAILED
    else -> ErrorKind.SERVER
}

fun classify(error: Throwable): ErrorKind = when (error) {
    is FetchException -> error.kind
    is SerializationException -> ErrorKind.BAD_RESPONSE
    is IllegalArgumentException -> ErrorKind.INVALID_URL
    is IOException -> ErrorKind.UNREACHABLE
    else -> ErrorKind.UNREACHABLE
}
