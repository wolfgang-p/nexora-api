'use strict';

/**
 * Scopes a "Login with Koro" app can request and a user can grant.
 *
 * These mirror the API-key scopes (api_keys/middleware.js ALL_SCOPES) plus
 * `profile:read`, which the consent screen always needs (display name + avatar
 * of the logged-in user). Keep this list in sync with:
 *   - the developer portal scope-picker (koro-developer)
 *   - the mobile consent screen labels (nexora-mobile)
 *   - the SDK + API.md docs
 *
 * Each scope maps to a short, human-readable consent label (DE/EN) shown to
 * the user before they approve. The server enforces scopes via
 * auth/middleware.js requireOAuthScope().
 */
const OAUTH_SCOPES = [
  { id: 'profile:read', de: 'Dein Profil (Name, Benutzername, Foto)', en: 'Your profile (name, username, photo)' },
  { id: 'conversations:read', de: 'Deine Unterhaltungen sehen', en: 'See your conversations' },
  { id: 'conversations:write', de: 'Unterhaltungen erstellen & verwalten', en: 'Create & manage conversations' },
  { id: 'messages:read', de: 'Deine Nachrichten lesen', en: 'Read your messages' },
  { id: 'messages:write', de: 'Nachrichten in deinem Namen senden', en: 'Send messages on your behalf' },
  { id: 'tasks:read', de: 'Deine Aufgaben sehen', en: 'See your tasks' },
  { id: 'tasks:write', de: 'Aufgaben erstellen & ändern', en: 'Create & change tasks' },
  { id: 'webhooks:manage', de: 'Webhooks verwalten', en: 'Manage webhooks' },
];

const OAUTH_SCOPE_IDS = OAUTH_SCOPES.map((s) => s.id);

/** Filter an arbitrary scope list down to the recognized, allowed ones. */
function sanitizeScopes(requested, allowed = OAUTH_SCOPE_IDS) {
  if (!Array.isArray(requested)) return [];
  const allow = new Set(allowed);
  const seen = new Set();
  const out = [];
  for (const s of requested) {
    if (typeof s !== 'string') continue;
    if (!OAUTH_SCOPE_IDS.includes(s)) continue; // must be a known scope
    if (!allow.has(s)) continue;                 // must be allowed for this client/grant
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

module.exports = { OAUTH_SCOPES, OAUTH_SCOPE_IDS, sanitizeScopes };
