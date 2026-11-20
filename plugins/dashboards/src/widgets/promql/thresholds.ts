/*
 * Thresholds colour a stat tile or a gauge. The text form is "70:warning, 90:critical":
 * from 70 the level is warning, from 90 it is critical, and below 70 it is good. With
 * `invert` a lower value is worse: "20:warning, 10:critical" reads as "20 or less".
 * The status colours are fixed. A level also has an icon and a word, so colour is never
 * the only cue.
 */
export type Level = 'good' | 'warning' | 'serious' | 'critical';

export interface ThresholdStep {
  value: number;
  level: Level;
}

export const LEVELS: readonly Level[] = ['good', 'warning', 'serious', 'critical'];

export const LEVEL_COLOUR: Record<Level, string> = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

export const LEVEL_LABEL: Record<Level, string> = {
  good: 'Good',
  warning: 'Warning',
  serious: 'Serious',
  critical: 'Critical',
};

/** An Iconify (Material Design) icon per level. */
export const LEVEL_ICON: Record<Level, string> = {
  good: 'mdi:check-circle-outline',
  warning: 'mdi:alert-outline',
  serious: 'mdi:alert-circle-outline',
  critical: 'mdi:close-circle-outline',
};

const ALIASES: Record<string, Level> = {
  good: 'good',
  ok: 'good',
  green: 'good',
  warning: 'warning',
  warn: 'warning',
  yellow: 'warning',
  serious: 'serious',
  orange: 'serious',
  critical: 'critical',
  crit: 'critical',
  red: 'critical',
};

export function parseThresholds(text: unknown): ThresholdStep[] {
  if (typeof text !== 'string') return [];
  const steps: ThresholdStep[] = [];
  for (const part of text.split(/[,\n]/)) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[:=]\s*([a-zA-Z]+)\s*$/.exec(part);
    if (!m) continue;
    const level = ALIASES[m[2].toLowerCase()];
    if (level) steps.push({ value: Number(m[1]), level });
  }
  return steps;
}

/**
 * The level of a value: the step with the largest threshold that the value reaches. Below
 * every step the level is `good`. Returns undefined when there are no steps (no status shown).
 */
export function thresholdLevel(value: number, steps: ThresholdStep[], invert = false): Level | undefined {
  if (steps.length === 0 || !Number.isFinite(value)) return undefined;
  const sorted = [...steps].sort((a, b) => (invert ? b.value - a.value : a.value - b.value));
  let level: Level = 'good';
  for (const s of sorted) {
    if (invert ? value <= s.value : value >= s.value) level = s.level;
  }
  return level;
}
