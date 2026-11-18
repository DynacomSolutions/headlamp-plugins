package app.headlamps

import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import java.io.IOException

@Serializable
enum class ErrorKind { UNREACHABLE, UNAUTHORIZED, METRICS_MISSING, NOT_FOUND, SERVER, BAD_RESPONSE, INVALID_URL }

class FetchException(val kind: ErrorKind, val code: Int? = null, cause: Throwable? = null) :
    Exception("Fetch failed: $kind", cause)

/** Maps an HTTP status to an error kind. [metrics] is true for the metrics endpoint. */
fun classifyHttp(code: Int, metrics: Boolean): ErrorKind = when {
    code == 401 || code == 403 -> ErrorKind.UNAUTHORIZED
    code == 503 -> ErrorKind.METRICS_MISSING
    code == 404 -> if (metrics) ErrorKind.METRICS_MISSING else ErrorKind.NOT_FOUND
    else -> ErrorKind.SERVER
}

fun classify(error: Throwable): ErrorKind = when (error) {
    is FetchException -> error.kind
    is SerializationException -> ErrorKind.BAD_RESPONSE
    is IllegalArgumentException -> ErrorKind.INVALID_URL
    is IOException -> ErrorKind.UNREACHABLE
    else -> ErrorKind.UNREACHABLE
}
