import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { Snapshot } from './storage-data';

export function size(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, bytes)) / 10));
  return `${(bytes / 1024 ** unit).toLocaleString('en-GB', {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  })} ${units[unit]}`;
}

export const time = (value: string) => new Date(value).toLocaleString('en-GB');

type CapacityValues = Pick<Snapshot, 'totalBytes' | 'availableBytes' | 'reserveBytes'>;

export function Capacity({ value }: { value: CapacityValues }) {
  const used = Math.max(0, value.totalBytes - value.availableBytes);
  const percent = value.totalBytes > 0 ? Math.min(100, (100 * used) / value.totalBytes) : 0;
  return (
    <Box>
      <Box display="flex" justifyContent="space-between" gap={1} flexWrap="wrap">
        <Typography fontWeight={600}>{size(value.availableBytes)} free</Typography>
        <Typography color="text.secondary" variant="body2">
          {size(used)} used of {size(value.totalBytes)}
        </Typography>
      </Box>
      <LinearProgress
        aria-label="Space used"
        color={value.availableBytes < value.reserveBytes ? 'error' : 'primary'}
        variant="determinate"
        value={percent}
        sx={{ my: 1, height: 7, borderRadius: 1 }}
      />
      <Typography variant="caption" color="text.secondary">
        {size(value.reserveBytes)} free space reserve
      </Typography>
    </Box>
  );
}

export function CapacityHistory({ snapshots }: { snapshots: Snapshot[] }) {
  const location = useLocation();
  const history = useHistory();
  const [hovered, setHovered] = React.useState<string>();
  const search = new URLSearchParams(location.search);
  const selected = snapshots.find(s => s.id === search.get('scan')) ?? snapshots[0];
  if (!selected) {
    return <Typography color="text.secondary">No scans to compare yet.</Typography>;
  }

  const display = snapshots.find(s => s.id === hovered) ?? selected;
  const samples = [...snapshots].reverse();
  const oldestAt = Date.parse(samples[0].scannedAt);
  const newestAt = Date.parse(samples[samples.length - 1].scannedAt);
  const maxBytes = Math.max(1, ...samples.map(s => s.totalBytes));
  const y = (bytes: number) => 111 - (100 * Math.max(0, bytes)) / maxBytes;
  const x = (sample: Snapshot, index: number) =>
    13 +
    574 *
      (newestAt > oldestAt
        ? (Date.parse(sample.scannedAt) - oldestAt) / (newestAt - oldestAt)
        : index / Math.max(1, samples.length - 1));
  const used = (sample: Snapshot) => sample.totalBytes - sample.availableBytes;
  const points = (value: (s: Snapshot) => number) =>
    samples.map((s, i) => `${x(s, i)},${y(value(s))}`).join(' ');
  const delta = display.complete && samples[0].complete ? used(display) - used(samples[0]) : null;
  const select = (id: string) => {
    if (id === snapshots[0].id) search.delete('scan');
    else search.set('scan', id);
    history.replace({ ...location, search: search.toString() });
  };

  return (
    <Box>
      <Box
        display="flex"
        gap={2}
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        mb={1}
      >
        <Typography component="h2" variant="h6">
          Capacity history
        </Typography>
        <TextField
          select
          size="small"
          label="Scan"
          value={selected.id}
          onChange={event => select(event.target.value)}
          sx={{ minWidth: 210 }}
        >
          {snapshots.map(s => (
            <MenuItem key={s.id} value={s.id}>
              {time(s.scannedAt)}
            </MenuItem>
          ))}
        </TextField>
      </Box>
      <Box sx={{ color: 'primary.main', lineHeight: 0, width: '100%' }}>
        <svg
          width="100%"
          height="128"
          viewBox="0 0 600 125"
          preserveAspectRatio="none"
          role="img"
          aria-label="Used space and reserved capacity over time. Use the Scan menu to inspect a point."
          onMouseLeave={() => setHovered(undefined)}
        >
          <polyline
            points={points(s => s.totalBytes - s.reserveBytes)}
            fill="none"
            stroke="currentColor"
            strokeOpacity=".45"
            strokeDasharray="5 5"
          />
          <polyline points={points(used)} fill="none" stroke="currentColor" strokeWidth="2" />
          {samples.map((s, i) => (
            <g key={s.id} onMouseEnter={() => setHovered(s.id)}>
              <circle cx={x(s, i)} cy={y(used(s))} r={12} fill="transparent" />
              <circle
                cx={x(s, i)}
                cy={y(used(s))}
                r={display.id === s.id ? 6 : 3}
                fill={s.complete ? 'currentColor' : 'white'}
                stroke="currentColor"
              />
            </g>
          ))}
        </svg>
      </Box>
      <Typography variant="caption" color="text.secondary">
        Solid · used space &nbsp; Dashed · capacity above the reserve
      </Typography>
      <Typography variant="body2" sx={{ mt: 1 }}>
        {time(display.scannedAt)} · {size(used(display))} used · {size(display.availableBytes)} free
        {delta !== null &&
          samples.length > 1 &&
          ` · ${delta < 0 ? '−' : '+'}${size(Math.abs(delta))} since the first scan`}
        {!display.complete && ' · Incomplete scan'}
      </Typography>
    </Box>
  );
}
