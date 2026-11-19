import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatMarkdown } from './chat-markdown';

const ANSWER = `# Findings

1. First step
2. Second step

- Parent
  - Nested child

See [the docs](https://example.com/docs) and [bad](javascript:alert(1)).

| Pod | State |
| --- | ----- |
| api | OOM |

Use \`kubectl get pods\` now.

> Be careful

~~old~~ <b>raw</b>

\`\`\`bash
kubectl top pod api
\`\`\`
`;

describe('ChatMarkdown', () => {
  it('renders lists, link, table, code, quote and heading', () => {
    const { container } = render(<ChatMarkdown source={ANSWER} />);
    expect(screen.getByRole('heading', { name: 'Findings' })).toBeTruthy();
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelectorAll('ul ul > li')).toHaveLength(1);
    const link = screen.getByRole('link', { name: 'the docs' });
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Pod' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'OOM' })).toBeTruthy();
    expect(screen.getByText('kubectl get pods').tagName).toBe('CODE');
    expect(container.querySelector('pre code')?.textContent).toBe('kubectl top pod api');
    expect(container.querySelector('blockquote')?.textContent).toContain('Be careful');
    expect(container.querySelector('del')).toBeTruthy();
  });
  it('does not render a javascript: link', () => {
    render(<ChatMarkdown source={ANSWER} />);
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.getByText('bad')).toBeTruthy();
  });
  it('shows raw HTML as text', () => {
    const { container } = render(<ChatMarkdown source={ANSWER} />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>raw</b>');
  });
  it('copies a code block', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ChatMarkdown source={ANSWER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('kubectl top pod api');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});
