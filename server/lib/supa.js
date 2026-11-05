'use strict';
// Supabase's REST API with the service key, server-side only. One instance, made in server.js.

module.exports = function (ctx) {
  const { SUPABASE_KEY, SUPABASE_URL } = ctx;

  // ---- Supabase REST helper (service key, server-side only) ----
  async function sb(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) throw new Error(`supabase ${path} -> ${r.status}`);
    return r.json();
  }
  // Paginated read — Supabase caps responses at 1000 rows (db-max-rows), so page via Range.
  async function sbRange(path) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Range-Unit': 'items', Range: `${from}-${from + 999}` },
      });
      if (!r.ok && r.status !== 206) throw new Error(`supabase ${path} -> ${r.status}`);
      const chunk = await r.json();
      out.push(...chunk);
      if (chunk.length < 1000) break;
    }
    return out;
  }
  async function sbWrite(path, method, body) {
    const init = {
      method,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, init);
    if (!r.ok) throw new Error(`supabase ${method} ${path} -> ${r.status}`);
  }

  // An insert whose failure the caller only needs as a boolean.
  async function sbInsert(table, row) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                   'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      return r.ok;
    } catch (_) { return false; }
  }
  // Upsert one app_settings row. app_settings is keyed, so this needs the merge-duplicates Prefer
  // header — a plain POST on an existing key 409s (which is why sbWrite, having no Prefer, can't
  // be used here). Throws on failure.
  async function putSetting(key, value) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error(`settings upsert ${key} -> ${r.status}`);
  }

  // Upsert one row of a keyed table (the same merge-duplicates Prefer as putSetting). Throws on failure.
  async function sbUpsert(table, conflict, row) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflict}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`upsert ${table} -> ${r.status}`);
  }

  return { sb, sbRange, sbWrite, sbInsert, putSetting, sbUpsert };
};
