import React from 'react';
import { Foo } from './pass-helper-component';

export const A = (p: Record<string, string>) => (
  <Foo
    label="x"
    {...p} // dashboard-links: allow fixture for the allow marker on the spread line
  />
);
