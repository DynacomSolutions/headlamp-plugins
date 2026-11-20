import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('contract.ts is a copyable file', () => {
  it('imports only React types, so other plugins can copy it', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'contract.ts'), 'utf8');
    const imports = src.split('\n').filter(l => /^import /.test(l));
    expect(imports).toEqual(["import type React from 'react';"]);
  });
});
