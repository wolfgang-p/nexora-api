const { sendJSON, sendError } = require('../utils/response');
const { generateOTP, hashOTP, signJWT } = require('../crypto/index');
const supabase = require('../db/supabase');

async function handleRequestOTP(req, res, body) {
  const { phone_number } = body;
  if (!phone_number) return sendError(res, 400, 'phone_number required');

  const otp = generateOTP();
  const otphash = hashOTP(otp);
  console.log(`[DEV ONLY] generated OTP for ${phone_number}: ${otp}`);

  const expires_at = new Date(Date.now() + 5 * 60 * 1000);

  const { error } = await supabase.from('otps').insert({
    phone_number,
    otp_hash: otphash,
    expires_at,
    used: false
  });

  if (error) return sendError(res, 500, error.message);
  sendJSON(res, 200, { message: 'OTP sent successfully' });
}

async function handleVerifyOTP(req, res, body) {
  const { phone_number, otp } = body;
  if (!phone_number || !otp) return sendError(res, 400, 'phone_number and otp required');

  const otphash = hashOTP(otp);

  const { data: otps, error: checkError } = await supabase
    .from('otps')
    .select('*')
    .eq('phone_number', phone_number)
    .eq('otp_hash', otphash)
    .eq('used', false)
    .gte('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: false })
    .limit(1);

  if (checkError) return sendError(res, 500, checkError.message);
  if (!otps || otps.length === 0) return sendError(res, 400, 'Invalid or expired OTP');

  await supabase.from('otps').update({ used: true }).eq('id', otps[0].id);

  let isNewUser = false;
  let { data: user, error: userError } = await supabase
    .from('users')
    .select('*')
    .eq('phone_number', phone_number)
    .single();

  if (userError && userError.code === 'PGRST116') {
    // User does not exist, Pങ്ങൾRST116 is single() found 0 rows
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({ phone_number })
      .select('*')
      .single();

    if (createError) return sendError(res, 500, createError.message);
    user = newUser;
    isNewUser = true;
  } else if (userError) {
    return sendError(res, 500, userError.message);
  }

  const token = signJWT({ userId: user.id, phone: user.phone_number, accountType: user.account_type });

  sendJSON(res, 200, {
    token,
    isNewUser,
    accountType: user.account_type,
    userId: user.id
  });
}

async function handleCompleteProfile(req, res, body) {
  if (!req.user) return; // Protected route wrapper already handles error

  const { display_name, username, account_type, public_key, avatar_url } = body;

  const { data: user, error } = await supabase
    .from('users')
    .update({
      display_name,
      username: username ? username.toLowerCase() : undefined,
      account_type,
      public_key,
      avatar_url
    })
    .eq('id', req.user.userId)
    .select('*')
    .single();

  if (error) return sendError(res, 500, error.message);
  sendJSON(res, 200, user);
}

module.exports = {
  handleRequestOTP,
  handleVerifyOTP,
  handleCompleteProfile
};
