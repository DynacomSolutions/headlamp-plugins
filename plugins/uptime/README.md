# uptime

A [Headlamp](https://headlamp.dev/) plugin for multi-site uptime checks. It
adds an **Uptime** sidebar entry with one row per check:

- **Status**: the check combined over its sites by its policy, the same way
  the alert rule combines it. `any`: down while any site fails. `all`: down
  only while every site fails, and *degraded* while some sites fail.
- One column per site (probe location): up or failing, probe duration, HTTP
  status, and 24-hour uptime in the tooltip.
- **TLS**: days until the soonest certificate expiry (amber under 14 days, red
  under 7). This applies to https and TLS checks.
- **24h** and **7d**: combined uptime over the window (one-minute and
  five-minute subqueries).
- A 24-hour history strip of 15-minute periods: green is no failures, amber is
  some, red is all, grey is no data.
- Expand a row to see a probe duration chart per site for the last 24 hours.

Failing and degraded checks sort to the top. The page refreshes every 30
seconds.

## Where the data comes from

[blackbox_exporter](https://github.com/prometheus/blackbox_exporter) probes
(HTTP status and keyword, TCP, TLS, DNS, ICMP), one exporter per site,
scraped into a Prometheus-compatible service (for example VictoriaMetrics).
The plugin reads them through the Kubernetes API server's Service proxy
(`src/metrics.ts`; namespace `monitoring`, Service `victoria-metrics:8428`, job
`uptime` by default; change the constants to match your cluster).

Every probe series must carry these labels, which your scrape config sets:

| Label | Meaning |
| --- | --- |
| `job` | the probe scrape job (`uptime`) |
| `target` | check name, one row per value |
| `location` | site the probe ran from, one column per value |
| `type` | `http`, `tcp`, `tls`, `dns` or `icmp` |
| `policy` | `all` or `any` |
| `instance` | probed URL or address |

Series used: `probe_success`, `probe_duration_seconds`,
`probe_http_status_code` and `probe_ssl_earliest_cert_expiry`.

A matching file_sd scrape job that probes every check from every site:

```yaml
- job_name: uptime
  metrics_path: /probe
  file_sd_configs:
    - files: [/etc/uptime/targets.yaml]
  relabel_configs:
    - {source_labels: [__address__], target_label: __param_target}
    - {source_labels: [__param_target], target_label: instance}
    - {source_labels: [__probe_address], target_label: __address__}
```

```yaml
# /etc/uptime/targets.yaml: one entry per check and site
- targets: ["https://example.com/"]
  labels: {target: web, type: http, location: site-a, policy: all,
           __param_module: web, __probe_address: "probe-site-a:9115"}
```

## Access needed

`get` on `services/proxy` for the metrics Service. Nothing else: the plugin
makes no other API calls and stores nothing.

## Release installation

Download `uptime-<version>.tar.gz` and `SHA256SUMS` from the matching GitHub
Release, verify the archive, and extract it into Headlamp's plugins directory.

```bash
sha256sum -c SHA256SUMS --ignore-missing
tar -xzf uptime-0.1.0.tar.gz -C /path/to/headlamp/plugins
```

## Development

```bash
npm ci
npm run tsc && npm run lint && npm test && npm run build
```
