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
    "${normaliseBase(base)}/c/${segment(cluster)}/usage/dashboard"

fun isCleartext(base: String): Boolean = base.trim().startsWith("http://", ignoreCase = true)

/** The headlamp-agent Service that the Kubernetes proxy reaches. */
const val AGENT_NAMESPACE = "headlamp-agent"
const val AGENT_SERVICE = "headlamp-agent:80"

private fun agentBase(base: String, cluster: String): String =
    "${normaliseBase(base)}/clusters/${segment(cluster)}/api/v1/namespaces/$AGENT_NAMESPACE/services/$AGENT_SERVICE/proxy/api/widgets"

fun panelsUrl(base: String, cluster: String): String = agentBase(base, cluster)

fun panelUrl(base: String, cluster: String, panelId: String): String = "${agentBase(base, cluster)}/${segment(panelId)}"

/** Turns a panel link such as "/c/{cluster}/uptime" into a full Headlamp URL. */
fun panelLinkUrl(base: String, cluster: String, link: String?): String {
    if (link.isNullOrBlank()) return normaliseBase(base)
    val path = link.replace("{cluster}", segment(cluster))
    return normaliseBase(base) + if (path.startsWith("/")) path else "/$path"
}
