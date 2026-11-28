import React from 'react';
import { Foo } from './pass-helper-component';

export const A = (p: Record<string, string>) => <Foo {...p} />;
