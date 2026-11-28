import React from 'react';

/** Scrolls to the bottom when `signal` changes, unless the user scrolled up or `enabled` is off (a link named an item to show). */
export function useStickToBottom(signal: unknown, enabled = true) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const stick = React.useRef(enabled);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  React.useEffect(() => {
    const el = ref.current;
    if (el && enabled && stick.current) el.scrollTop = el.scrollHeight;
  }, [signal, enabled]);
  return { ref, onScroll };
}
