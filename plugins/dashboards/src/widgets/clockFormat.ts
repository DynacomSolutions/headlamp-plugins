/*
 * Clock formatting with a small date-format language (a subset of Unicode date patterns):
 *   yyyy yy   year          MMMM MMM MM M   month (name, short name, 2 digits, number)
 *   EEEE EEE  weekday       dd d            day of month
 *   HH H      hour 24       hh h            hour 12       mm m   minute   ss s   second
 *   a         AM or PM      'text'          literal text     ''  a quote
 * Any other character is copied. Time zones use Intl, so any IANA zone name works.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1 to 12
  day: number;
  weekday: number; // 0 Sunday to 6 Saturday
  hour: number; // 0 to 23
  minute: number;
  second: number;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The browser's own zone is the empty string. */
export const LOCAL_ZONE = '';

export function isValidZone(zone: string): boolean {
  if (zone === LOCAL_ZONE) return true;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date: Date, zone: string): ZonedParts {
  if (zone === LOCAL_ZONE || !isValidZone(zone)) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      weekday: date.getDay(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const short = get('weekday').slice(0, 3);
  const weekday = WEEKDAYS.findIndex(d => d.slice(0, 3) === short);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: weekday < 0 ? 0 : weekday,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

const two = (n: number) => String(n).padStart(2, '0');

/** Format `parts` with a pattern. Unknown letters are copied as they are. */
export function formatPattern(parts: ZonedParts, pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "'") {
      if (pattern[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      // Quoted text runs to the next single quote; a doubled quote inside it is a quote.
      let j = i + 1;
      while (j < pattern.length) {
        if (pattern[j] === "'") {
          if (pattern[j + 1] === "'") {
            out += "'";
            j += 2;
            continue;
          }
          break;
        }
        out += pattern[j];
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    let n = 1;
    while (pattern[i + n] === ch) n += 1;
    i += n;
    const h12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
    switch (ch) {
      case 'y':
        out += n === 2 ? two(parts.year % 100) : String(parts.year).padStart(n, '0');
        break;
      case 'M':
        out += n >= 4 ? MONTHS[parts.month - 1] : n === 3 ? MONTHS[parts.month - 1].slice(0, 3) : n === 2 ? two(parts.month) : String(parts.month);
        break;
      case 'E':
        out += n >= 4 ? WEEKDAYS[parts.weekday] : WEEKDAYS[parts.weekday].slice(0, 3);
        break;
      case 'd':
        out += n >= 2 ? two(parts.day) : String(parts.day);
        break;
      case 'H':
        out += n >= 2 ? two(parts.hour) : String(parts.hour);
        break;
      case 'h':
        out += n >= 2 ? two(h12) : String(h12);
        break;
      case 'm':
        out += n >= 2 ? two(parts.minute) : String(parts.minute);
        break;
      case 's':
        out += n >= 2 ? two(parts.second) : String(parts.second);
        break;
      case 'a':
        out += parts.hour < 12 ? 'AM' : 'PM';
        break;
      default:
        out += ch.repeat(n);
    }
  }
  return out;
}

export interface ClockConfig {
  showHours: boolean;
  showMinutes: boolean;
  showSeconds: boolean;
  /** 12 or 24. */
  hourFormat: '12' | '24';
  showDate: boolean;
  /** A preset id, or 'custom' to use `customDateFormat`. */
  dateFormat: string;
  customDateFormat: string;
  /** An IANA zone name, or '' for the browser's zone. */
  timeZone: string;
  /** Text size: relative to the widget. */
  size: 'small' | 'medium' | 'large' | 'xlarge';
  /** Also show the zone name under the date. */
  showZone: boolean;
}

export const DATE_FORMATS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'EEE d MMM yyyy', label: 'EEE d MMM yyyy (Thu 19 Nov 2026)' },
  { value: 'EEEE d MMMM yyyy', label: 'EEEE d MMMM yyyy (Thursday 19 November 2026)' },
  { value: 'yyyy-MM-dd', label: 'yyyy-MM-dd (2026-11-19)' },
  { value: 'd/M/yyyy', label: 'd/M/yyyy (19/11/2026)' },
  { value: 'dd/MM/yyyy', label: 'dd/MM/yyyy (19/11/2026)' },
  { value: 'MMM d, yyyy', label: 'MMM d, yyyy (Nov 19, 2026)' },
];
export const CUSTOM_FORMAT = 'custom';

export const DEFAULT_CLOCK: ClockConfig = {
  showHours: true,
  showMinutes: true,
  showSeconds: false,
  hourFormat: '24',
  showDate: true,
  dateFormat: 'EEE d MMM yyyy',
  customDateFormat: 'EEE d MMM yyyy',
  timeZone: LOCAL_ZONE,
  size: 'large',
  showZone: false,
};

/** The time pattern for the config, or '' when no part is shown. Seconds alone are allowed. */
export function timePattern(c: Pick<ClockConfig, 'showHours' | 'showMinutes' | 'showSeconds' | 'hourFormat'>): string {
  const bits: string[] = [];
  if (c.showHours) bits.push(c.hourFormat === '12' ? 'h' : 'HH');
  if (c.showMinutes) bits.push('mm');
  if (c.showSeconds) bits.push('ss');
  let p = bits.join(':');
  // A 12-hour clock without hours has no AM or PM.
  if (c.hourFormat === '12' && c.showHours) p += ' a';
  return p;
}

export function datePattern(c: Pick<ClockConfig, 'dateFormat' | 'customDateFormat'>): string {
  return c.dateFormat === CUSTOM_FORMAT ? c.customDateFormat : c.dateFormat;
}

export function formatClockParts(date: Date, c: ClockConfig): { time: string; date: string } {
  const parts = zonedParts(date, c.timeZone);
  const tp = timePattern(c);
  return {
    time: tp ? formatPattern(parts, tp) : '',
    date: c.showDate ? formatPattern(parts, datePattern(c)) : '',
  };
}

/** The tick length: a clock that shows seconds ticks each second, otherwise each minute. */
export function tickMs(c: Pick<ClockConfig, 'showSeconds'>): number {
  return c.showSeconds ? 1000 : 60_000;
}

/** Milliseconds from `now` to the next tick boundary, never 0. */
export function msToNextTick(now: number, step: number): number {
  return step - (now % step) || step;
}

export function commonZones(): string[] {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof fn === 'function') {
    try {
      return ['UTC', ...fn('timeZone').filter(z => z !== 'UTC')];
    } catch {
      // Fall through to the short list.
    }
  }
  return ['UTC', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Asia/Bangkok', 'Asia/Tokyo', 'Australia/Sydney'];
}
