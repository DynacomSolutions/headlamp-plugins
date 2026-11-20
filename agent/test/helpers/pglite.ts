import { PGlite } from '@electric-sql/pglite';
import { PgDiagnosisStore, type Db, type StoreOptions } from '../../src/store.js';

/** A `Db` on PGlite, a real PostgreSQL in the test process. Give it a directory to keep the data across a "restart". */
export function pgliteDb(dataDir?: string): Db & { raw: PGlite } {
  const raw = new PGlite(dataDir);
  const rows = (r: { rows: unknown[]; affectedRows?: number }) => ({ rows: r.rows as never[], rowCount: r.affectedRows ?? r.rows.length });
  return {
    raw,
    query: async (text, params) => rows(await raw.query(text, params as never[])),
    transaction: fn => raw.transaction(async tx => fn({ query: async (text, params) => rows(await tx.query(text, params as never[])) })),
    close: () => raw.close(),
  };
}

/** A store on `db`, as one pod of a rollout. Two of them on one `db` are two pods on one database. */
export async function podStore(db: Db, options: StoreOptions = {}, dataDir = ''): Promise<PgDiagnosisStore> {
  const store = new PgDiagnosisStore(db, dataDir, options);
  await store.init();
  return store;
}
