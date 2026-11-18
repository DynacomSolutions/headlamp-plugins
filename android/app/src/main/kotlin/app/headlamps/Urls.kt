package app.headlamps

import java.net.URLEncoder

fun normaliseBase(base: String): String = base.trim().trimEnd('/')

private fun segment(value: String): String =
    URLEncoder.encode(value, "UTF-8").replace("+", "%20")

fun configUrl(base: String): String = "${normaliseBase(base)}/config"

fun metricsUrl(base: String, cluster: String): String =
    "${normaliseBase(base)}/clusters/${segment(cluster)}/apis/metrics.k8s.io/v1beta1/nodes"

fun nodesUrl(base: String, cluster: String): String =
    "${normaliseBase(base)}/clusters/${segment(cluster)}/api/v1/nodes"

fun usagePageUrl(base: String, cluster: String): String =
    "${normaliseBase(base)}/c/${segment(cluster)}/usage/nodes"

fun isCleartext(base: String): Boolean = base.trim().startsWith("http://", ignoreCase = true)
