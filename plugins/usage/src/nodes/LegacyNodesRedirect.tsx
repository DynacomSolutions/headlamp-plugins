/*
 * The Nodes page was renamed the Usage dashboard. This keeps old /usage/nodes links and cabinet
 * bookmarks working: it replaces the history entry with /usage/dashboard and keeps the query.
 */
import { Redirect, useLocation } from 'react-router-dom';

export function LegacyNodesRedirect(): JSX.Element {
  const { search } = useLocation();
  return <Redirect to={{ pathname: '/usage/dashboard', search }} />;
}
