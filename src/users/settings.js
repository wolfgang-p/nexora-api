'use strict';

/**
 * User settings — theme + accessibility + privacy prefs.
 * GET  /users/me/settings
 * PUT  /users/me/settings
 *
 * Stored in the existing `user_settings` table. Most fields default
 * sane on the client, so a missing row maps to defaults.
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, serverError } = require('../util/response');

const FIELDS = [
  'theme_mode', 'theme_accent', 'chat_wallpaper',
  'animated_avatar', 'reduce_motion', 'larger_text', 'high_contrast',
  'read_receipts_enabled', 'typing_indicators_enabled',
  'auto_translate_enabled', 'auto_translate_target', 'auto_translate_show_original',
];

async function get(req, res) {
  const { data } = await supabase.from('user_settings').select('*')
    .eq('user_id', req.auth.userId).maybeSingle();
  ok(res, { settings: data || { user_id: req.auth.userId } });
}

async function update(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const patch = {};
  for (const f of FIELDS) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  // Constrain enum-like fields.
  if (patch.theme_mode && !['light', 'dark', 'system'].includes(patch.theme_mode)) {
    return badRequest(res, 'theme_mode must be light|dark|system');
  }
  if (patch.theme_accent && !/^#[0-9a-fA-F]{6}$/.test(String(patch.theme_accent))) {
    return badRequest(res, 'theme_accent must be #RRGGBB');
  }

  if (Object.keys(patch).length === 0) return ok(res, {});

  // Upsert — row may not exist yet for old users.
  patch.user_id = req.auth.userId;
  const { data, error } = await supabase.from('user_settings')
    .upsert(patch, { onConflict: 'user_id' }).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { settings: data });
}

module.exports = { get, update };
