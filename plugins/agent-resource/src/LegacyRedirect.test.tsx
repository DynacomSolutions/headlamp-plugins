import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Switch, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { currentRoute, LEGACY_ROUTE, LegacyRedirect, ROUTE } from './LegacyRedirect';

afterEach(cleanup);

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}${l.hash}`}</div>;
}

function app(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Switch>
        <Route path={`/c/:cluster${LEGACY_ROUTE}`} component={LegacyRedirect} />
        <Route path={LEGACY_ROUTE} component={LegacyRedirect} />
        <Route path={`/c/:cluster${ROUTE}`} component={Where} />
        <Route path={ROUTE} component={Where} />
      </Switch>
    </MemoryRouter>
  );
}

describe('LegacyRedirect', () => {
  it('moves /agent-memory to /agent-resource and keeps query and hash', () => {
    const { getByTestId } = app('/agent-memory?q=build#top');
    expect(getByTestId('where').textContent).toBe('/agent-resource?q=build#top');
  });
  it('leaves the new route alone', () => {
    const { getByTestId } = app('/agent-resource?q=x');
    expect(getByTestId('where').textContent).toBe('/agent-resource?q=x');
  });
  it('keeps the cluster prefix of /c/<cluster>/agent-memory, with query and hash', () => {
    const { getByTestId } = app('/c/dynacom/agent-memory?x=1#h');
    expect(getByTestId('where').textContent).toBe('/c/dynacom/agent-resource?x=1#h');
  });
  it('builds the target from the current path', () => {
    expect(currentRoute('/agent-memory')).toBe('/agent-resource');
    expect(currentRoute('/c/dynacom/agent-memory')).toBe('/c/dynacom/agent-resource');
    expect(currentRoute('/c/dynacom/agent-memory/')).toBe('/c/dynacom/agent-resource');
    expect(currentRoute('/c/a%20b/agent-memory')).toBe('/c/a%20b/agent-resource');
    expect(currentRoute('/elsewhere')).toBe('/agent-resource');
  });
});
