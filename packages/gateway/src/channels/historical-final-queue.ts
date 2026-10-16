import type {DatabaseSync} from 'node:sqlite';
/** The existing outbox keeps its identities and receipts. Older consumers do
 * not claim this reserved pending state; it is not send authority by itself.
 * Bootstrap calls this within the existing migration transaction. */
export function installHistoricalDispatchProtocol(db:DatabaseSync){
 const clean="generation=0 AND provider_receipt_json IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL";
 const isolate=(where:string)=>`UPDATE ga_channel_deliveries SET
  status=CASE WHEN ${clean} THEN 'historical_pending' ELSE 'outcome_unknown' END,
  last_reason_code=CASE WHEN ${clean} THEN last_reason_code ELSE COALESCE(last_reason_code,'HISTORICAL_PRIOR_ATTEMPT_UNCONFIRMED') END,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='pending' AND ${where};`;
 db.exec(`CREATE TRIGGER IF NOT EXISTS historical_delivery_dispatch_isolation AFTER INSERT ON ga_historical_final_delivery_grants
  BEGIN ${isolate('effect_id=NEW.effect_id')} END;
  CREATE TRIGGER IF NOT EXISTS historical_delivery_pending_no_downgrade BEFORE UPDATE OF status ON ga_channel_deliveries
  WHEN NEW.status='pending' AND OLD.status<>'pending'
   AND EXISTS(SELECT 1 FROM ga_historical_final_delivery_grants g WHERE g.effect_id=OLD.effect_id)
  BEGIN SELECT RAISE(ABORT,'historical_delivery_downgrade_forbidden'); END;`);
 // Retain immutable snapshots and all already-attempted send/receipt states.
 db.exec(isolate('EXISTS(SELECT 1 FROM ga_historical_final_delivery_grants g WHERE g.effect_id=ga_channel_deliveries.effect_id)'));
}
