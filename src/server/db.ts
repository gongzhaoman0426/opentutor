import { Pool, type PoolClient } from 'pg';

const state = globalThis as typeof globalThis & { opentutorPool?: Pool; opentutorMigration?: Promise<void> };
export function getPool() {
  if (!state.opentutorPool) {
    state.opentutorPool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://opentutor:opentutor@127.0.0.1:54329/opentutor', max: 10, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000 });
    state.opentutorPool.on('error', () => {});
  }
  return state.opentutorPool;
}
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function initDb() {
  if (!state.opentutorMigration) {
    state.opentutorMigration = withTransaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('opentutor_schema_v1'))");
      await c.query(`
        CREATE TABLE IF NOT EXISTS projects (id uuid PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS project_revisions (project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, revision integer NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id, revision));
        CREATE TABLE IF NOT EXISTS jobs (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data jsonb NOT NULL, lease_token uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now());
        CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs(project_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS job_events (id bigserial PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, stage text NOT NULL, message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
        CREATE INDEX IF NOT EXISTS events_job_idx ON job_events(job_id, id);
        CREATE TABLE IF NOT EXISTS generation_results (id uuid PRIMARY KEY, job_id uuid UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, input_revision integer NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS job_outbox (job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, dispatched_at timestamptz, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
        ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS dispatch_generation integer NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS idempotency_keys (project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key text NOT NULL, request_hash text NOT NULL, job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, PRIMARY KEY(project_id, key));
        CREATE TABLE IF NOT EXISTS artifacts (id uuid PRIMARY KEY, path text NOT NULL, mime text NOT NULL, name text NOT NULL, project_id uuid REFERENCES projects(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS worker_heartbeat (id text PRIMARY KEY, touched_at timestamptz NOT NULL);
      `);
    }).catch(error => { delete state.opentutorMigration; throw error; });
  }
  await state.opentutorMigration;
}
export async function closeDb() {
  if (state.opentutorPool) await state.opentutorPool.end();
  delete state.opentutorPool;
  delete state.opentutorMigration;
}
