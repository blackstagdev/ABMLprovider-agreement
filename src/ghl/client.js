// HighLevel (LeadConnector) REST client: throttled, retries 429/5xx, never logs payloads.
import { GHL_API_BASE, GHL_CONTACTS_VERSION, GHL_DOCUMENTS_VERSION } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GHL's explanation for a failed request (validation messages, e.g. on 422), safe to log:
 * emails are masked and the text is truncated. Never includes request data we sent.
 */
export async function errorReason(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return '';
  }
  let msg = text;
  try {
    const j = JSON.parse(text);
    const m = j.message ?? j.msg ?? j.error ?? j.errors;
    msg = Array.isArray(m) ? m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ') : typeof m === 'string' ? m : JSON.stringify(m ?? j);
  } catch {
    /* not JSON */
  }
  return msg.replace(/[^\s@"']+@[^\s@"']+\.[^\s@"']+/g, '[email]').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function createGhlClient({ token, locationId, requestsPerSecond = 8, fetchImpl = fetch, baseUrl = GHL_API_BASE }) {
  let nextSlot = 0;
  const gap = Math.ceil(1000 / Math.max(1, requestsPerSecond));

  async function request(method, path, { query, body, version } = {}) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + gap;
      if (wait) await sleep(wait);
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: version,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.status === 204 ? null : res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < 5) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const reason = await errorReason(res);
      const err = new Error(`GHL ${method} ${url.pathname} failed with ${res.status}${reason ? `: ${reason}` : ''}`);
      err.status = res.status;
      err.ghlReason = reason;
      throw err;
    }
  }

  return {
    locationId,
    /** GET /proposals/document — paginated with limit/skip, `total` in response. */
    listDocuments({ limit = 100, skip = 0, status, query, dateFrom, dateTo } = {}) {
      return request('GET', '/proposals/document', {
        version: GHL_DOCUMENTS_VERSION,
        query: { locationId, limit, skip, status, query, dateFrom, dateTo },
      });
    },
    async getContact(contactId) {
      const r = await request('GET', `/contacts/${encodeURIComponent(contactId)}`, { version: GHL_CONTACTS_VERSION });
      return r?.contact ?? null;
    },
    /** Exact-email contact search (used to detect shared practice emails). */
    async searchContactsByEmail(email) {
      const r = await request('POST', '/contacts/search', {
        version: GHL_CONTACTS_VERSION,
        body: { locationId, pageLimit: 10, filters: [{ field: 'email', operator: 'eq', value: email }] },
      });
      return r?.contacts ?? [];
    },
    addContactTags(contactId, tags) {
      return request('POST', `/contacts/${encodeURIComponent(contactId)}/tags`, { version: GHL_CONTACTS_VERSION, body: { tags } });
    },
  };
}
