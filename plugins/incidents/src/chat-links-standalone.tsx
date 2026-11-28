/*
 * The link of a chat answer on the plugin's own pages: an anchor that opens in a new tab. Importing
 * this file sets it. Dashboard widgets must never import it (see chat-links.tsx).
 */
import Link from '@mui/material/Link';
import { setStandaloneChatLink } from './chat-links';

setStandaloneChatLink(({ url, children }) => (
  <Link href={url} target="_blank" rel="noopener noreferrer">
    {children}
  </Link>
));
