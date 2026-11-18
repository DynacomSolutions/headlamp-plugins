import React from 'react';

/*
 * A small, safe Markdown subset: headings (#..####), **bold**, _italic_, `code`,
 * line breaks, bullet lines. Everything is emitted as React elements and text,
 * so HTML in the source shows as text. Links keep their label only; images are
 * not supported.
 */

const INLINE =
  /(\*\*[^*\n]+\*\*|`[^`\n]+`|(?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9])|\[[^\]\n]*\]\([^)\n]*\))/;

export function renderInline(text: string, keyPrefix = 'i'): React.ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}${i}`;
    if (!part) return null;
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{renderInline(part.slice(2, -2), `${key}.`)}</strong>;
    }
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={key}
          style={{
            fontFamily: 'monospace',
            fontSize: '0.9em',
            padding: '0 0.25em',
            background: 'rgba(127,127,127,0.18)',
            borderRadius: 3,
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.length > 2 && part.startsWith('_') && part.endsWith('_')) {
      return <em key={key}>{renderInline(part.slice(1, -1), `${key}.`)}</em>;
    }
    const link = /^\[([^\]\n]*)\]\(([^)\n]*)\)$/.exec(part);
    if (link) return <React.Fragment key={key}>{link[1]}</React.Fragment>;
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

/** Lines joined with <br/>; a trailing double space is just a line break too. */
function renderLines(lines: string[], keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${keyPrefix}br${i}`} />);
    out.push(...renderInline(line.replace(/\s+$/, ''), `${keyPrefix}l${i}.`));
  });
  return out;
}

export function renderMarkdown(source: string): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let bullets: string[] = [];
  const flushPara = () => {
    if (para.length)
      blocks.push(
        <p key={`p${blocks.length}`} style={{ margin: 0 }}>
          {renderLines(para, `p${blocks.length}`)}
        </p>
      );
    para = [];
  };
  const flushBullets = () => {
    if (bullets.length) {
      const k = `u${blocks.length}`;
      blocks.push(
        <ul key={k} style={{ margin: 0, paddingLeft: '1.4em' }}>
          {bullets.map((b, i) => (
            <li key={i}>{renderInline(b, `${k}.${i}.`)}</li>
          ))}
        </ul>
      );
    }
    bullets = [];
  };
  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushBullets();
      const level = heading[1].length;
      const k = `h${blocks.length}`;
      const size = ['1.5em', '1.3em', '1.15em', '1.05em'][level - 1];
      blocks.push(
        <div key={k} role="heading" aria-level={level} style={{ fontWeight: 600, fontSize: size }}>
          {renderInline(heading[2], `${k}.`)}
        </div>
      );
    } else if (bullet) {
      flushPara();
      bullets.push(bullet[1]);
    } else if (line.trim() === '') {
      flushPara();
      flushBullets();
    } else {
      flushBullets();
      para.push(line);
    }
  }
  flushPara();
  flushBullets();
  return blocks;
}
