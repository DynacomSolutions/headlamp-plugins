// A clean widget: text, an image in SVG, a comment that names href= and target="_blank".
import React from 'react';
import { helper } from './pass-helper';

export function Widget({ url }: { url: string }) {
  // href="https://example.com" in a comment is not a link.
  return (
    <svg>
      <image href={url} width={10} height={10} />
      <span title={helper(url)}>{url}</span>
    </svg>
  );
}
