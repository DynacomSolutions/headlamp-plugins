/*
 * Where the Prometheus-compatible metrics service is, read from the Dashboards plugin settings
 * (the same key as the settings page). The service is reached through the Kubernetes API
 * service proxy, like the other plugins do it.
 */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';

export interface MetricsEndpoint {
  namespace: string;
  service: string;
  port: string;
  /** A path prefix in front of /api/v1, for example `/prometheus`. Blank for none. */
  pathPrefix: string;
}

export const DEFAULT_ENDPOINT: MetricsEndpoint = {
  namespace: 'monitoring',
  service: 'victoria-metrics',
  port: '8428',
  pathPrefix: '',
};

const NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PORT = /^(\d{1,5}|[a-z0-9]([-a-z0-9]{0,13}[a-z0-9])?)$/;
const PREFIX = /^\/[A-Za-z0-9._~\-/]*$/;

export const isEndpointName = (s: string): boolean => NAME.test(s);
export const isEndpointPort = (s: string): boolean => PORT.test(s);
export const isPathPrefix = (s: string): boolean => PREFIX.test(s);

function field(stored: Record<string, unknown> | undefined, key: string): string {
  const v = stored?.[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** A blank or invalid field gives the default, so a typo cannot build a bad URL. */
export function resolveEndpoint(stored: Record<string, unknown> | undefined): MetricsEndpoint {
  const ns = field(stored, 'metricsNamespace');
  const service = field(stored, 'metricsService');
  const port = field(stored, 'metricsPort');
  const prefix = field(stored, 'metricsPathPrefix').replace(/\/+$/, '');
  return {
    namespace: isEndpointName(ns) ? ns : DEFAULT_ENDPOINT.namespace,
    service: isEndpointName(service) ? service : DEFAULT_ENDPOINT.service,
    port: isEndpointPort(port) ? port : DEFAULT_ENDPOINT.port,
    pathPrefix: prefix !== '' && isPathPrefix(prefix) ? prefix : '',
  };
}

const store = new ConfigStore<Record<string, unknown>>('dashboards');

export function useMetricsEndpoint(): MetricsEndpoint {
  const stored = store.useConfig()() as Record<string, unknown> | undefined;
  const ns = stored?.metricsNamespace;
  const service = stored?.metricsService;
  const port = stored?.metricsPort;
  const prefix = stored?.metricsPathPrefix;
  return React.useMemo(
    () => resolveEndpoint({ metricsNamespace: ns, metricsService: service, metricsPort: port, metricsPathPrefix: prefix }),
    [ns, service, port, prefix]
  );
}
