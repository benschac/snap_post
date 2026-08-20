import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  migrations: {
    prefix: 'supabase',
  },
  out: '../../supabase/migrations',
  schema: './src/database/schema.ts',
  schemaFilter: ['snap_to_post'],
  strict: true,
  verbose: true,
});
