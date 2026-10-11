import test from 'node:test';
import assert from 'node:assert/strict';
import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts';

test('composed services share one atomic transaction and outer failure rolls back nested writes', () => {
  const db = openProductDatabase(':memory:');
  try {
    db.exec('CREATE TABLE nested_fixture(id INTEGER PRIMARY KEY)');
    assert.throws(() => withImmediateTransaction(db, () => {
      db.prepare('INSERT INTO nested_fixture VALUES(1)').run();
      withImmediateTransaction(db, () => db.prepare('INSERT INTO nested_fixture VALUES(2)').run());
      throw new Error('fixture_outer_failure');
    }), /fixture_outer_failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nested_fixture').get().n, 0);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('failed nested operation can be handled without preserving its partial writes', () => {
  const db = openProductDatabase(':memory:');
  try {
    db.exec('CREATE TABLE nested_fixture(id INTEGER PRIMARY KEY)');
    withImmediateTransaction(db, () => {
      db.prepare('INSERT INTO nested_fixture VALUES(1)').run();
      assert.throws(() => withImmediateTransaction(db, () => {
        db.prepare('INSERT INTO nested_fixture VALUES(2)').run();
        throw new Error('fixture_inner_failure');
      }), /fixture_inner_failure/);
      db.prepare('INSERT INTO nested_fixture VALUES(3)').run();
    });
    assert.deepEqual(db.prepare('SELECT id FROM nested_fixture ORDER BY id').all().map(row => row.id), [1, 3]);
  } finally { db.close(); }
});
