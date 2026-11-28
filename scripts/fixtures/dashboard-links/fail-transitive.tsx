import React from 'react';
import { Leaky } from './fail-transitive-child';

export const A = () => <Leaky />;
