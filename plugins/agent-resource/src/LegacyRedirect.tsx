/*
 * The page was called Agent memory at /agent-memory. This keeps old links and bookmarks working:
 * it replaces the history entry with /agent-resource and keeps the query and the hash.
 */
import { Redirect, useLocation } from 'react-router-dom';

export const ROUTE = '/agent-resource';
export const LEGACY_ROUTE = '/agent-memory';

export function LegacyRedirect(): JSX.Element {
  const { search, hash } = useLocation();
  return <Redirect to={{ pathname: ROUTE, search, hash }} />;
}
