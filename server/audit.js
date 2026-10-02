// Append-only audit log of important actions.
import { getDb, nowIso } from './db.js';

export function audit(req, action, { entityType = null, entityId = null, details = null, user = null } = {}) {
  const u = user || req?.user || null;
  getDb()
    .prepare(`INSERT INTO audit_log (at, user_id, username, action, entity_type, entity_id, details, ip)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      nowIso(),
      u?.id ?? null,
      u?.username ?? null,
      action,
      entityType,
      entityId == null ? null : String(entityId),
      details == null ? null : JSON.stringify(details),
      req?.ip ?? null,
    );
}
