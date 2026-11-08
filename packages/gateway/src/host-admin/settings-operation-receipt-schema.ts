import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

/** Exact receipt-table DDL approved by R; version and fence schemas stay separate. */
export const HOST_SETTINGS_OPERATION_RECEIPT_DDL_APPROVED=`CREATE TABLE ga_host_settings_operations (
 operation_id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 host_instance_id TEXT NOT NULL,
 policy_epoch INTEGER NOT NULL CHECK(policy_epoch BETWEEN 1 AND 9007199254740991),
 namespace TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation = 'settings.update'),
 idempotency_key TEXT NOT NULL,
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 1 AND 9007199254740991),
 expected_dsh_revision INTEGER NOT NULL CHECK(expected_dsh_revision BETWEEN 0 AND 9007199254740991),
 base_settings_sha256 TEXT NOT NULL CHECK(length(base_settings_sha256)=64 AND base_settings_sha256 NOT GLOB '*[^0-9a-f]*'),
 schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64 AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'),
 patch_sha256 TEXT NOT NULL CHECK(length(patch_sha256)=64 AND patch_sha256 NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','completed','unknown','no_side_effect')),
 reservation_token_sha256 TEXT CHECK(reservation_token_sha256 IS NULL OR (length(reservation_token_sha256)=64 AND reservation_token_sha256 NOT GLOB '*[^0-9a-f]*')),
 reservation_expires_at TEXT,
 host_proof_json TEXT CHECK(host_proof_json IS NULL OR length(CAST(host_proof_json AS BLOB))<=8192),
 result_json TEXT CHECK(result_json IS NULL OR length(CAST(result_json AS BLOB))<=65536),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(owner_id,operation,idempotency_key),
 CHECK((state='reserved' AND reservation_token_sha256 IS NOT NULL AND reservation_expires_at IS NOT NULL)
  OR (state<>'reserved' AND reservation_token_sha256 IS NULL AND reservation_expires_at IS NULL)),
 CHECK(state NOT IN ('completed','no_side_effect') OR result_json IS NOT NULL),
 CHECK(state<>'completed' OR host_proof_json IS NOT NULL)
)`;

function fingerprint(sql:string):string{
 return createHash('sha256').update(sql.replace(/\s+/g,' ').trim(),'utf8').digest('hex');
}
export const HOST_SETTINGS_OPERATION_RECEIPT_SCHEMA_SHA256_APPROVED=fingerprint(HOST_SETTINGS_OPERATION_RECEIPT_DDL_APPROVED);

export function assertHostSettingsOperationReceiptSchema(db:DatabaseSync):string{
 const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ga_host_settings_operations'").get() as {sql?:unknown}|undefined;
 if(typeof row?.sql!=='string'||fingerprint(row.sql)!==HOST_SETTINGS_OPERATION_RECEIPT_SCHEMA_SHA256_APPROVED)
  throw new Error('host_settings_receipt_schema_mismatch_offline_migration_required');
 return HOST_SETTINGS_OPERATION_RECEIPT_SCHEMA_SHA256_APPROVED;
}

