export const go = (history: { replace(p: string): void }, p: string) =>
  history
    .replace(p);
