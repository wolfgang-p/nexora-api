'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

/**
 * Service-role Supabase client. Bypasses RLS. NEVER expose this to end users.
 * All authz enforcement happens in the API layer.
 */
const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = { supabase };
