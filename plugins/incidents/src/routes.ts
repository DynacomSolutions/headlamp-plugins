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
export const ROUTE_LAUNCHES = 'incidents-launches';
export const ROUTE_LAUNCH = 'incidents-launch';
export const ROUTE_STORAGE = 'incidents-storage';
export const ROUTE_STORAGE_DRIVE = 'incidents-storage-drive';
export const ROUTE_STORAGE_ITEM = 'incidents-storage-item';
export const ROUTE_STORAGE_CHAT = 'incidents-storage-chat';
export const ROUTE_STORAGE_QUESTION = 'incidents-storage-question';
export const ROUTE_STORAGE_FINDING = 'incidents-storage-finding';

export const diagnosesUrl = (): string => Router.createRouteURL(ROUTE_DIAGNOSES);

export const diagnosisUrl = (id: string): string => Router.createRouteURL(ROUTE_DIAGNOSIS, { id });

/** What a storage chat link may carry. The drive is the context of the chat and the other two focus one open item. */
export interface ChatLinkParams {
  drive?: string;
  question?: string;
  finding?: string;
}

/** The chat is a path segment. The drive context and the focused item are query strings, so the URL alone shows the view. */
export const chatUrl = (id?: string, params: ChatLinkParams = {}): string => {
  const path = id
    ? Router.createRouteURL(ROUTE_CHAT_THREAD, { id })
    : Router.createRouteURL(ROUTE_CHAT);
  const query = new URLSearchParams();
  if (params.drive) query.set('drive', params.drive);
  if (params.question) query.set('question', params.question);
  if (params.finding) query.set('finding', params.finding);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
};

export const launchesUrl = (): string => Router.createRouteURL(ROUTE_LAUNCHES);

export const launchUrl = (id: string): string => Router.createRouteURL(ROUTE_LAUNCH, { id });

export const storageUrl = (): string => Router.createRouteURL(ROUTE_STORAGE);

export const storageDriveUrl = (driveId: string): string =>
  Router.createRouteURL(ROUTE_STORAGE_DRIVE, { driveId });

export const storageItemUrl = (driveId: string, itemId: string): string =>
  Router.createRouteURL(ROUTE_STORAGE_ITEM, { driveId, itemId });

export const storageQuestionUrl = (driveId: string, id: string): string =>
  Router.createRouteURL(ROUTE_STORAGE_QUESTION, { driveId, actionId: id });

export const storageFindingUrl = (driveId: string, id: string): string =>
  Router.createRouteURL(ROUTE_STORAGE_FINDING, { driveId, actionId: id });

/**
 * The URL templates the plugin gives the agent for storage notifications. The agent fills `{chatId}`, `{driveId}` and
 * `{id}`. A notification opens the storage investigation in the Chat tab, on the drive, with the item in focus.
 */
export function storageNotificationUrls() {
  const chat = 'CHAT-MARK';
  const drive = 'DRIVE-MARK';
  const id = 'NOTICE-MARK';
  const template = (path: string) =>
    path.replace(chat, '{chatId}').replace(drive, '{driveId}').replace(id, '{id}');
  return {
    question: template(chatUrl(chat, { drive, question: id })),
    cleanup: template(chatUrl(chat, { drive, finding: id })),
  };
}

export const ROUTE_NOTIFICATIONS = 'incidents-notifications';

export const notificationsUrl = (): string => Router.createRouteURL(ROUTE_NOTIFICATIONS);
