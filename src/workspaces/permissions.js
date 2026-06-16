'use strict';

/**
 * Workspace role → default permission map, plus per-member overrides.
 *
 * `workspace_members.permissions` (JSONB, from 0001_core) holds boolean
 * overrides on top of these role defaults. `effectivePerms` merges them:
 * an override key always wins over the role default.
 *
 * Keys are intentionally coarse — a handful of capabilities that map to
 * real UI actions. Add new keys here AND to DEFAULT_PERMS.member so the
 * member-update sanitiser keeps them.
 */

const PERMISSION_KEYS = [
  'manage_workspace',   // edit settings, name, avatar
  'manage_members',     // invite, change roles, remove
  'manage_channels',    // create/delete channels
  'post_messages',      // write in channels
  'drive_upload',       // add files to drive
  'drive_delete_any',   // delete others' files
  'manage_tasks',       // create/assign tasks
  'edit_wiki',          // create/edit wiki pages
];

function perms(map) {
  const out = {};
  for (const k of PERMISSION_KEYS) out[k] = !!map[k];
  return out;
}

const DEFAULT_PERMS = {
  owner: perms(Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]))),
  admin: perms({
    manage_workspace: true, manage_members: true, manage_channels: true,
    post_messages: true, drive_upload: true, drive_delete_any: true,
    manage_tasks: true, edit_wiki: true,
  }),
  member: perms({
    post_messages: true, drive_upload: true, manage_tasks: true, edit_wiki: true,
  }),
  guest: perms({
    post_messages: true,
  }),
};

/**
 * Effective permissions for a member = role defaults with per-member
 * boolean overrides applied on top.
 */
function effectivePerms(role, overrides = {}) {
  const base = DEFAULT_PERMS[role] || DEFAULT_PERMS.member;
  const out = { ...base };
  for (const k of PERMISSION_KEYS) {
    if (typeof overrides[k] === 'boolean') out[k] = overrides[k];
  }
  return out;
}

/** Does (role, overrides) grant `key`? */
function can(role, overrides, key) {
  return !!effectivePerms(role, overrides)[key];
}

module.exports = { PERMISSION_KEYS, DEFAULT_PERMS, effectivePerms, can };
