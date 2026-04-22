'use strict';

const { supabase } = require('../db/supabase');

/**
 * Log a privileged action to audit_events. Best-effort; never throws.
 */
async function audit({
  userId = null,
  deviceId = null,
  apiKeyId = null,
  workspaceId = null,
  action,
  targetType = null,
  targetId = null,
  metadata = {},
  req = null,
}) {
  try {
    const ip = req ? (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress) : null;
    const userAgent = req ? req.headers['user-agent'] : null;
    await supabase.from('audit_events').insert({
      actor_user_id: userId,
      actor_device_id: deviceId,
      actor_api_key_id: apiKeyId,
      workspace_id: workspaceId,
      action,
      target_type: targetType,
      target_id: targetId,
      metadata,
      ip_address: ip,
      user_agent: userAgent,
    });
  } catch (err) {
    console.error('[audit]', action, err?.message || err);
  }
}

module.exports = { audit };
