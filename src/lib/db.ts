import pg from "pg";

// COUNT(*) and other bigint results come back as strings by default; our numbers are small.
pg.types.setTypeParser(20, (v) => Number(v));

/**
 * Postgres access. Schema changes live in /migrations and are applied with `npm run migrate`
 * (never from application start-up). Connection comes from DATABASE_URL.
 */
export type Queryable = {
  /** Runs a parameterised query ($1, $2, ...) and returns plain row objects. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

const g = globalThis as { __enwPool?: pg.Pool };

function pool(): pg.Pool {
  if (!g.__enwPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
    g.__enwPool = new pg.Pool({ connectionString: url, max: 10 });
  }
  return g.__enwPool;
}

export const db: Queryable = {
  async query(text, params) {
    return (await pool().query(text, params as unknown[])).rows;
  },
};

/** Runs fn in one transaction; rolls back if it throws. */
export async function tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn({
      async query(text, params) {
        return (await client.query(text, params as unknown[])).rows;
      },
    });
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDb() {
  await g.__enwPool?.end();
  g.__enwPool = undefined;
}
