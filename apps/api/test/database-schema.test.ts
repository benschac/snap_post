import assert from 'node:assert/strict';
import test from 'node:test';

import { getTableConfig } from 'drizzle-orm/pg-core';

import {
  claimEvidenceSources,
  claims,
  controlEvents,
  evidenceSources,
  images,
  itemIntents,
  itemTracks,
  priceObservations,
  sessions,
} from '../src/database/schema.ts';

const tables = [
  sessions,
  itemIntents,
  itemTracks,
  images,
  controlEvents,
  evidenceSources,
  claims,
  claimEvidenceSources,
  priceObservations,
];

test('keeps every prototype table isolated in the snap_to_post schema', () => {
  const configs = tables.map(getTableConfig);

  assert.deepEqual(
    configs.map(({ name }) => name),
    [
      'sessions',
      'item_intents',
      'item_tracks',
      'images',
      'control_events',
      'evidence_sources',
      'claims',
      'claim_evidence_sources',
      'price_observations',
    ],
  );
  assert.deepEqual(
    new Set(configs.map(({ schema }) => schema)),
    new Set(['snap_to_post']),
  );
});

test('declares row-level security in the Drizzle schema', () => {
  for (const table of tables) {
    const config = getTableConfig(table);
    assert.equal(
      config.enableRLS,
      true,
      `${config.schema}.${config.name} must enable row-level security`,
    );
  }
});

test('indexes every foreign-key column used outside a leading unique index', () => {
  for (const table of tables) {
    const config = getTableConfig(table);
    const indexedColumns = new Set(
      config.indexes.flatMap((item) =>
        item.config.columns.flatMap((column) =>
          'name' in column && typeof column.name === 'string'
            ? [column.name]
            : [],
        ),
      ),
    );

    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      for (const column of reference.columns) {
        assert.ok(
          indexedColumns.has(column.name),
          `${config.name}.${column.name} must have an index`,
        );
      }
    }
  }
});
