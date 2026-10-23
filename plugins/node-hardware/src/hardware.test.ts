import { describe, expect, it } from 'vitest';
import {
  batterySeverity,
  buildBatteries,
  buildPower,
  buildSensors,
  columnPower, pickCpuTemps,
  tempSeverity,
  totalPowerW,
} from './hardware';
import type { MetricSample } from './metrics';

const sample = (metric: Record<string, string>, value: number): MetricSample => ({
  metric,
  value: [0, String(value)],
});

const id = { node: 'worker-1', chip: 'c0', sensor: 'temp1' };

describe('buildSensors', () => {
  it('joins label, chip name and limits by sensor', () => {
    const sensors = buildSensors(
      [sample(id, 55)],
      [sample({ ...id, label: 'Package id 0' }, 1)],
      [sample({ node: 'worker-1', chip: 'c0', chip_name: 'coretemp' }, 1)],
      [sample(id, 100)],
      [sample(id, 105)],
    );
    expect(sensors).toEqual([
      { ...id, chipName: 'coretemp', label: 'Package id 0', value: 55, max: 100, crit: 105 },
    ]);
  });

  it('keeps sensors with no label, chip name or limits', () => {
    const [s] = buildSensors([sample(id, 40)], [], [], [], []);
    expect(s).toMatchObject({ chipName: '', label: '', value: 40, max: undefined, crit: undefined });
  });
});

describe('pickCpuTemps', () => {
  const t = (node: string, chipName: string, value: number) => ({ node, chip: chipName, chipName, sensor: 't', label: '', value });

  it('prefers the hottest CPU-chip sensor over a hotter non-CPU one', () => {
    const picked = pickCpuTemps([t('worker-1', 'nvme', 70), t('worker-1', 'coretemp', 50), t('worker-1', 'k10temp', 60)]);
    expect(picked.get('worker-1')?.value).toBe(60);
  });

  it('falls back to the hottest sensor overall when no CPU chip exists', () => {
    const picked = pickCpuTemps([t('worker-2', 'nvme', 40), t('worker-2', 'amdgpu', 65)]);
    expect(picked.get('worker-2')?.value).toBe(65);
  });
});

describe('tempSeverity', () => {
  it('uses sensor max and crit when present', () => {
    expect(tempSeverity(70, 70, 95)).toBe('warn');
    expect(tempSeverity(95, 70, 95)).toBe('crit');
    expect(tempSeverity(69, 70, 95)).toBe('ok');
  });
  it('falls back to 80 / 90 C', () => {
    expect(tempSeverity(79)).toBe('ok');
    expect(tempSeverity(80)).toBe('warn');
    expect(tempSeverity(90)).toBe('crit');
  });
});

describe('power', () => {
  it('merges per-node figures and sums package + GPU', () => {
    const power = buildPower(
      [sample({ node: 'worker-1' }, 40)],
      [sample({ node: 'worker-1' }, 5)],
      [sample({ node: 'worker-1' }, 100), sample({ node: 'worker-2' }, 20)],
    );
    expect(power.get('worker-1')).toEqual({ packageW: 40, dramW: 5, gpuW: 100 });
    expect(totalPowerW(power.get('worker-1'))).toBe(140);
    expect(totalPowerW(power.get('worker-2'))).toBe(20);
  });

  it('returns undefined without package or GPU figures', () => {
    expect(totalPowerW(undefined)).toBeUndefined();
    expect(totalPowerW({ dramW: 5 })).toBeUndefined();
  });
});

const mac = (name: string, value: number) => sample({ __name__: name, node: 'mac-1' }, value);

describe('buildBatteries / batterySeverity', () => {
  const parse = (extra: [string, number][] = []) =>
    buildBatteries(
      [
        ['node_mac_battery_design_capacity_mah', 5000],
        ['node_mac_battery_max_capacity_mah', 4500],
        ['node_mac_battery_external_connected', 1],
        ['node_mac_battery_current_amperes', -1.5],
        ...extra,
      ].map(([n, v]) => mac(n as string, v as number)),
    ).get('mac-1')!;

  it('parses numbers, signed current and 0/1 flags', () => {
    expect(parse()).toEqual({ designMah: 5000, maxMah: 4500, external: true, amps: -1.5 });
  });
  it('is ok at 90 %, amber below 80 %, red below 60 % or on failure', () => {
    expect(batterySeverity(parse())).toBe('ok');
    expect(batterySeverity({ designMah: 100, maxMah: 79 })).toBe('warn');
    expect(batterySeverity({ designMah: 100, maxMah: 59 })).toBe('crit');
    expect(batterySeverity(parse([['node_mac_battery_permanent_failure', 1]]))).toBe('crit');
  });
  it('is ok when capacities are unknown', () => {
    expect(batterySeverity({})).toBe('ok');
  });
});

describe('columnPower', () => {
  it('prefers measured system power', () => {
    const power = buildPower([sample({ node: 'mac-1' }, 10)], [], [], [mac('node_mac_power_system_watts', 30), mac('node_mac_power_ane_watts', 1)]);
    expect(columnPower(power.get('mac-1'))).toEqual({ watts: 30, measured: true });
    expect(power.get('mac-1')?.aneW).toBe(1);
  });
  it('falls back to the CPU + GPU estimate, or undefined', () => {
    expect(columnPower({ packageW: 10, gpuW: 5 })).toEqual({ watts: 15, measured: false });
    expect(columnPower({})).toBeUndefined();
  });
});
