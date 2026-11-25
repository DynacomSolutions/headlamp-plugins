import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, readSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const diagnosticHeader = 'x-storage-diagnostic-job';
const dispatchId = /^[a-z0-9][a-z0-9-]{0,51}-([1-9][0-9]{0,11})\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const nodeName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const maxStartDelaySeconds = 240;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export interface DiagnosticDispatch {
  job: string;
  nodes: ReadonlySet<string>;
}

export function diagnosticGeneration(): string {
  const proc = readFileSync('/proc/self/stat', 'utf8');
  const fields = proc.slice(proc.lastIndexOf(') ') + 2).trim().split(/\s+/u);
  return `${readlinkSync('/proc/self/ns/pid')}:${process.pid}:${fields[19]}`;
}

/** Accept one matching authenticated request on the exact armed process. */
export class ScheduledDiagnostic {
  private spent = false;

  constructor(private readonly dataDir: string, private readonly now: () => number = Date.now) {}

  claim(values: string[] | undefined): DiagnosticDispatch | undefined {
    if (this.spent || !this.dataDir || values?.length !== 1) return undefined;
    const [job] = values;
    const scheduled = dispatchId.exec(job);
    if (!scheduled || scheduled[0] !== job) return undefined;
    const start = Number(scheduled[1]) * 60;
    try {
      const parent = openSync(join(this.dataDir, '.storage-diagnostic'), directoryFlags);
      try {
        const info = fstatSync(parent);
        const uid = process.geteuid?.();
        if (info.uid !== uid || (info.mode & 0o7777) !== 0o700) return undefined;
        const arm = `/proc/self/fd/${parent}/arm`;
        const fd = openSync(arm, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let fields: string[];
        try {
          const info = fstatSync(fd);
          if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) return undefined;
          const data = Buffer.alloc(257);
          const size = readSync(fd, data);
          if (size > 256 || data.subarray(0, size).some(byte => byte > 127)) return undefined;
          fields = data.toString('utf8', 0, size).trimEnd().split(' ');
        } finally {
          closeSync(fd);
        }
        const [armedJob, deadline, generation, first, second] = fields;
        if (fields.length !== 5 || armedJob !== job || !/^[0-9]{1,12}$/u.test(deadline)
            || !nodeName.test(first) || !nodeName.test(second) || first === second) return undefined;
        const now = Math.floor(this.now() / 1000);
        const expires = Number(deadline);
        if (now < start || expires <= now || expires > start + maxStartDelaySeconds
            || generation !== diagnosticGeneration()) return undefined;
        // Spend the match even if the unlink fails. Only a successful unlink grants capture.
        this.spent = true;
        unlinkSync(arm);
        return { job, nodes: new Set([first, second]) };
      } finally {
        closeSync(parent);
      }
    } catch {
      // An unavailable arm has no effect on ordinary reconcile.
      return undefined;
    }
  }
}
