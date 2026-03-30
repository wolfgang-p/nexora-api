require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function test() {
  const wsId = '117070f2-dec9-4682-bb8e-cb5f00ecb181';
  const userId = '0adc552a-554a-49a9-a15a-753e668ad60d';

  const { data: mem, error: memErr } = await supabase.from('workspace_members').insert({
    workspace_id: wsId,
    user_id: userId,
    role: 'owner'
  }).select('*').single();

  if (memErr) console.error('Member Error:', memErr);
  else console.log('Member Success:', mem);

  const { data: chan, error: chanErr } = await supabase.from('workspace_channels').insert({
    workspace_id: wsId,
    name: 'general',
    type: 'text',
    created_by: userId
  }).select('*').single();

  if (chanErr) console.error('Chan Error:', chanErr);
  else console.log('Chan Success:', chan);
}

test();
