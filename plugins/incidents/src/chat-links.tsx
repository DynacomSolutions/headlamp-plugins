/*
 * How a link in a chat answer is drawn. The plugin's own pages draw an anchor that opens in a new
 * tab (chat-links-standalone.tsx sets it at start). A dashboard never has such a link: a link in a
 * dashboard or kiosk view must not leave the dashboard (see AGENTS.md, "Dashboard and kiosk
 * links"). So the default is plain text with the address in its tooltip, and the dashboard
 * widgets also set `TextLink` through `ChatLinkContext`. This file draws no anchor on purpose:
 * `scripts/check-dashboard-links.mjs` follows the imports of the dashboard widgets through it.
 */
import React from 'react';

/** A safe address (http or https) and the text of the link. */
export type ChatLink = React.ComponentType<{ url: string; children?: React.ReactNode }>;

/** Plain text. The address is in the tooltip and can be selected, so a reader can copy it. */
export const TextLink: ChatLink = ({ url, children }) => (
  <span title={url} style={{ textDecoration: 'underline dotted' }}>
    {children}
  </span>
);

let standalone: ChatLink = TextLink;

/** Sets the link component of the plugin's own pages. */
export function setStandaloneChatLink(link: ChatLink): void {
  standalone = link;
}

/** The link component of the nearest provider, else the one of the plugin's own pages. */
export const ChatLinkContext = React.createContext<ChatLink | null>(null);

export function useChatLink(): ChatLink {
  return React.useContext(ChatLinkContext) ?? standalone;
}
