import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../contract';
import {
  ClockConfig,
  commonZones,
  CUSTOM_FORMAT,
  DATE_FORMATS,
  DEFAULT_CLOCK,
  formatClockParts,
  isValidZone,
  LOCAL_ZONE,
  msToNextTick,
  tickMs,
} from './clockFormat';
import { SettingsForm } from './SettingsForm';

const SIZES: Record<ClockConfig['size'], { time: string; date: string }> = {
  small: { time: 'clamp(1.2rem, 14cqmin, 2.2rem)', date: 'clamp(0.7rem, 5cqmin, 1rem)' },
  medium: { time: 'clamp(1.8rem, 22cqmin, 3.6rem)', date: 'clamp(0.8rem, 7cqmin, 1.3rem)' },
  large: { time: 'clamp(2.4rem, 32cqmin, 6rem)', date: 'clamp(0.9rem, 9cqmin, 1.8rem)' },
  xlarge: { time: 'clamp(3rem, 46cqmin, 10rem)', date: 'clamp(1rem, 12cqmin, 2.6rem)' },
};

/** The current time, ticking on each second or minute boundary with one timer at a time. */
export function useTick(step: number): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, msToNextTick(Date.now(), step));
    };
    setNow(new Date());
    timer = setTimeout(tick, msToNextTick(Date.now(), step));
    return () => clearTimeout(timer);
  }, [step]);
  return now;
}

/** The clock in the one row header: time over date, in the height of the row, with no card. */
function CompactClock(props: { config: ClockConfig; now: Date }): JSX.Element {
  const { config, now } = props;
  const { time, date } = formatClockParts(now, config);
  const zone = config.showZone
    ? config.timeZone === LOCAL_ZONE
      ? 'Local time'
      : config.timeZone
    : '';
  const second = [date, zone].filter(Boolean).join(' · ');
  return (
    <Box
      data-clock-widget
      data-clock-compact=""
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        justifyContent: 'center',
        textAlign: 'right',
        whiteSpace: 'nowrap',
      }}
    >
      {time && (
        <Typography
          component="div"
          data-clock-time
          sx={{
            fontSize: '1.5rem',
            fontWeight: 600,
            lineHeight: 1.1,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {time}
        </Typography>
      )}
      {second && (
        <Typography
          component="div"
          data-clock-date
          color="text.secondary"
          sx={{ fontSize: '0.75rem', lineHeight: 1.2 }}
        >
          {second}
        </Typography>
      )}
    </Box>
  );
}

export function ClockView(props: {
  config: ClockConfig;
  now: Date;
  compact?: boolean;
}): JSX.Element {
  const { config, now } = props;
  if (props.compact) return <CompactClock config={config} now={now} />;
  const { time, date } = formatClockParts(now, config);
  const size = SIZES[config.size] ?? SIZES.large;
  return (
    <Box
      data-clock-widget
      sx={{
        height: '100%',
        containerType: 'size',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        overflow: 'hidden',
      }}
    >
      {time && (
        <Typography
          component="div"
          data-clock-time
          sx={{
            fontSize: size.time,
            fontWeight: 600,
            lineHeight: 1.05,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {time}
        </Typography>
      )}
      {date && (
        <Typography
          component="div"
          data-clock-date
          color="text.secondary"
          sx={{ fontSize: size.date }}
        >
          {date}
        </Typography>
      )}
      {config.showZone && (
        <Typography
          component="div"
          data-clock-zone
          color="text.secondary"
          sx={{ fontSize: size.date, opacity: 0.8 }}
        >
          {config.timeZone === LOCAL_ZONE ? 'Local time' : config.timeZone}
        </Typography>
      )}
    </Box>
  );
}

function ClockWidget({ config, compact }: WidgetProps<ClockConfig>): JSX.Element {
  const merged = React.useMemo(() => ({ ...DEFAULT_CLOCK, ...config }), [config]);
  const now = useTick(tickMs(merged));
  return <ClockView config={merged} now={now} compact={compact} />;
}

function ClockSettings({ config, onChange }: WidgetSettingsProps<ClockConfig>): JSX.Element {
  const zones = React.useMemo(() => commonZones(), []);
  const zoneInvalid = config.timeZone !== LOCAL_ZONE && !isValidZone(config.timeZone);
  return (
    <SettingsForm
      config={config}
      onChange={onChange}
      fields={[
        { key: 'showHours', label: 'Show hours', type: 'boolean' },
        { key: 'showMinutes', label: 'Show minutes', type: 'boolean' },
        { key: 'showSeconds', label: 'Show seconds', type: 'boolean' },
        {
          key: 'hourFormat',
          label: 'Hours',
          type: 'select',
          options: [
            { value: '24', label: '24 hour' },
            { value: '12', label: '12 hour (AM or PM)' },
          ],
        },
        { key: 'showDate', label: 'Show the date', type: 'boolean' },
        {
          key: 'dateFormat',
          label: 'Date format',
          type: 'select',
          options: [...DATE_FORMATS, { value: CUSTOM_FORMAT, label: 'Custom format' }],
        },
        ...(config.dateFormat === CUSTOM_FORMAT
          ? [
              {
                key: 'customDateFormat',
                label: 'Custom date format',
                type: 'text' as const,
                help: "yyyy year, MMMM MMM MM M month, EEEE EEE weekday, dd d day. Put text in single quotes, for example 'Week' d.",
              },
            ]
          : []),
        {
          key: 'timeZone',
          label: 'Time zone',
          type: 'select',
          help: zoneInvalid
            ? 'This time zone is not known here, so local time is shown.'
            : undefined,
          options: [
            { value: LOCAL_ZONE, label: 'Browser local time' },
            ...(zoneInvalid ? [{ value: config.timeZone, label: config.timeZone }] : []),
            ...zones.map(z => ({ value: z, label: z })),
          ],
        },
        { key: 'showZone', label: 'Show the time zone name', type: 'boolean' },
        {
          key: 'size',
          label: 'Size',
          type: 'select',
          options: [
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
            { value: 'xlarge', label: 'Extra large' },
          ],
        },
      ]}
    />
  );
}

export const clockWidget: WidgetDefinition<ClockConfig> = {
  type: 'core.clock',
  title: 'Clock',
  description: 'The time and date, in any time zone.',
  icon: 'mdi:clock-outline',
  category: 'Time',
  defaultSize: { w: 3, h: 4 },
  minSize: { w: 2, h: 2 },
  defaultConfig: DEFAULT_CLOCK,
  SettingsComponent: ClockSettings,
  Component: ClockWidget,
};
