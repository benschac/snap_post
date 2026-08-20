import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.ts';

const DEFAULT_MAX_CONNECTIONS = 5;

export type Database = PostgresJsDatabase<typeof schema>;

export type DatabaseClient = {
  db: Database;
  close: () => Promise<void>;
};

export type DatabaseClientOptions = {
  databaseUrl?: string;
  maxConnections?: number;
};

function requireDatabaseUrl(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error('DATABASE_URL is required to create the database client');
  }

  return value;
}

function readMaxConnections(value: number | undefined): number {
  const maxConnections = value ?? DEFAULT_MAX_CONNECTIONS;
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new Error('maxConnections must be a positive integer');
  }

  return maxConnections;
}

export function createDatabaseClient(
  options: DatabaseClientOptions = {},
): DatabaseClient {
  const databaseUrl = requireDatabaseUrl(
    options.databaseUrl ?? process.env.DATABASE_URL,
  );
  const sqlClient = postgres(databaseUrl, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: readMaxConnections(options.maxConnections),
    prepare: false,
  });

  return {
    db: drizzle(sqlClient, { schema }),
    close: () => sqlClient.end(),
  };
}
