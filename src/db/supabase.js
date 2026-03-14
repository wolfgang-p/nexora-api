const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://example.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || 'your-service-key';

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
