import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

export const CHECKPOINT_SCHEMA = 'sahaj_checkpoints';

/** No migrations here: run the explicit setup command once before workers start. */
export function createPostgresCheckpointer(connectionString: string): PostgresSaver {
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
    throw new Error('Invalid checkpoint PostgreSQL connection configuration');
  }
  return PostgresSaver.fromConnString(connectionString, { schema: CHECKPOINT_SCHEMA });
}
