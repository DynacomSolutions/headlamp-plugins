export interface Range {
  from: number;
  to: number;
}
export const span = (from: number, to: number): Range => ({ from, to });
export const keyframes = { from: { opacity: 0 }, to: { opacity: 1 } };
export function name(href: string | undefined, to: string): string {
  return `${href} ${to}`;
}
