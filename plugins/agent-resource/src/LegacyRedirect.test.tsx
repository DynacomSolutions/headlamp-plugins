import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Switch, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_ROUTE, LegacyRedirect, ROUTE } from './LegacyRedirect';

afterEach(cleanup);

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}${l.hash}`}</div>;
}

function app(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Switch>
        <Route path={LEGACY_ROUTE} component={LegacyRedirect} />
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
});
