import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Switch, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboardPathFor, LegacyNodesRedirect } from './LegacyNodesRedirect';

afterEach(cleanup);

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search + l.hash}</div>;
}

function app(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Switch>
        <Route exact path="/c/:cluster/usage/nodes" component={LegacyNodesRedirect} />
        <Route exact path="/usage/nodes" component={LegacyNodesRedirect} />
        <Route path="/c/:cluster/usage/dashboard/:zoom*" component={Where} />
        <Route path="/usage/dashboard/:zoom*" component={Where} />
      </Switch>
    </MemoryRouter>
  );
}

describe('LegacyNodesRedirect', () => {
  it('keeps the cluster prefix and the query of /c/<cluster>/usage/nodes', () => {
    const { getByTestId } = app('/c/main/usage/nodes?nodes=worker-1');
    expect(getByTestId('where').textContent).toBe('/c/main/usage/dashboard?nodes=worker-1');
  });
  it('keeps the hash', () => {
    const { getByTestId } = app('/c/main/usage/nodes?kiosk=1#top');
    expect(getByTestId('where').textContent).toBe('/c/main/usage/dashboard?kiosk=1#top');
  });
  it('keeps a cluster name that needs encoding', () => {
    const { getByTestId } = app('/c/a%20b/usage/nodes?nodes=worker-1');
    expect(decodeURI(getByTestId('where').textContent ?? '')).toBe(
      '/c/a b/usage/dashboard?nodes=worker-1'
    );
  });
  it('works without a cluster prefix', () => {
    const { getByTestId } = app('/usage/nodes?nodes=worker-1');
    expect(getByTestId('where').textContent).toBe('/usage/dashboard?nodes=worker-1');
  });
  it('builds the target from the current path', () => {
    expect(dashboardPathFor('/usage/nodes')).toBe('/usage/dashboard');
    expect(dashboardPathFor('/c/example/usage/nodes')).toBe('/c/example/usage/dashboard');
    expect(dashboardPathFor('/c/example/usage/nodes/')).toBe('/c/example/usage/dashboard');
    expect(dashboardPathFor('/c/a%20b/usage/nodes')).toBe('/c/a%20b/usage/dashboard');
    expect(dashboardPathFor('/elsewhere')).toBe('/usage/dashboard');
  });
});
