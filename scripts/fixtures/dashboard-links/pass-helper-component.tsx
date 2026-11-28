import React from 'react';

export const Foo = (p: { label?: string }) => <span>{p.label}</span>;
export const Button = (p: { children: React.ReactNode }) => <button>{p.children}</button>;
