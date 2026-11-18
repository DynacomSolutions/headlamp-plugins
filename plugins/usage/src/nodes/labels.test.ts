import { describe, expect, it } from 'vitest';
import { processLabel, unitLabel } from './labels';

describe('processLabel', () => {
  it('uses the program basename', () => {
    expect(processLabel('/home/u/.npm/bin/claude --mcp-config=/x.json')).toBe('claude');
  });
  it('looks through interpreters', () => {
    expect(processLabel('node /x/y/cli.js --foo')).toBe('node cli.js');
    expect(processLabel('/usr/bin/python3 -u /opt/app/run.py')).toBe('python3 run.py');
  });
  it('keeps a package scope and drops the version', () => {
    expect(processLabel('npx -y @scope/pkg@1.2 serve')).toBe('npx @scope/pkg');
    expect(processLabel('npx -y pkg@2.0.1')).toBe('npx pkg');
  });
  it('handles launchers without arguments and empty input', () => {
    expect(processLabel('bash')).toBe('bash');
    expect(processLabel('bash -l')).toBe('bash');
    expect(processLabel('')).toBe('(unknown)');
    expect(processLabel('   ')).toBe('(unknown)');
  });
});

describe('unitLabel', () => {
  it('drops suffix and orchestrator prefix', () => {
    expect(unitLabel('app-t3code-agents-builds.slice')).toBe('builds');
    expect(unitLabel('herdr-kill-ledger.service')).toBe('kill-ledger');
    expect(unitLabel('herdr-native-control-2835-1831.scope')).toBe('native-control-2835-1831');
    expect(unitLabel('app-t3code-web.scope')).toBe('web');
  });
  it('honours a custom prefix and never returns empty', () => {
    expect(unitLabel('foo-bar.scope', 'foo-')).toBe('bar');
    expect(unitLabel('herdr-.service')).toBe('herdr-');
    expect(unitLabel('.slice')).toBe('.slice');
  });
});
