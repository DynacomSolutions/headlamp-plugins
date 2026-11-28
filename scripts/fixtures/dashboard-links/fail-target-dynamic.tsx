import React from 'react';
import { Foo } from './pass-helper-component';

export const A = ({ t }: { t: string }) => <Foo target={t}>x</Foo>;
