/*
 * In-app URLs of the incidents plugin. Headlamp serves the routes under
 * /c/<cluster>/..., so every link is built with Router.createRouteURL, which
 * adds the current cluster. Never write an '/incidents' path by hand.
 */
import { Router } from '@kinvolk/headlamp-plugin/lib';

export const ROUTE_DIAGNOSES = 'incidents';
export const ROUTE_DIAGNOSIS = 'incident';
export const ROUTE_CHAT = 'incidents-chat';
export const ROUTE_CHAT_THREAD = 'incidents-chat-thread';

export const diagnosesUrl = (): string => Router.createRouteURL(ROUTE_DIAGNOSES);

export const diagnosisUrl = (id: string): string => Router.createRouteURL(ROUTE_DIAGNOSIS, { id });

export const chatUrl = (id?: string): string =>
  id ? Router.createRouteURL(ROUTE_CHAT_THREAD, { id }) : Router.createRouteURL(ROUTE_CHAT);
