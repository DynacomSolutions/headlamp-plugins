/*
 * Calls onIdle once after `seconds` with no pointerdown anywhere in the document, while active.
 * Kiosk use: the Usage dashboard goes back to the overview when nobody has touched the screen.
 */
import React from 'react';

export function useIdle(active: boolean, seconds: number, onIdle: () => void): void {
  const callback = React.useRef(onIdle);
  callback.current = onIdle;

  React.useEffect(() => {
    if (!active) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => callback.current(), seconds * 1000);
    };
    arm();
    // Capture phase, so a handler that stops propagation still counts as a touch.
    document.addEventListener('pointerdown', arm, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', arm, true);
    };
  }, [active, seconds]);
}
