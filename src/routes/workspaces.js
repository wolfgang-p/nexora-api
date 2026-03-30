const supabase = require('../db/supabase');
const { sendJSON, sendError } = require('../utils/response');
const { randomBytes } = require('crypto');

async function handleListWorkspaces(req, res) {
  try {
    const { data, error } = await supabase
      .from('workspace_members')
      .select('role, workspaces(*)')
      .eq('user_id', req.user.userId);
      
    if (error) return sendError(res, 500, error.message);
    
    // Map data to match expected output
    const result = (data || [])
      .map(m => ({ ...m.workspaces, role: m.role }))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      
    sendJSON(res, 200, result);
  } catch (err) {
    console.error('List workspaces error:', err);
    sendError(res, 500, 'Error listing workspaces');
  }
}

async function handleCreateWorkspace(req, res, body) {
  const { name, description, avatar_url } = body;
  if (!name) return sendError(res, 400, 'Workspace name is required');
  
  try {
    const { data: workspace, error: wsError } = await supabase
      .from('workspaces')
      .insert({ name, description, avatar_url, owner_id: req.user.userId })
      .select('*')
      .single();
      
    if (wsError) return sendError(res, 500, wsError.message);

    await supabase.from('workspace_members').insert({
      workspace_id: workspace.id,
      user_id: req.user.userId,
      role: 'owner'
    });

    await supabase.from('workspace_channels').insert({
      workspace_id: workspace.id,
      name: 'general',
      type: 'text',
      created_by: req.user.userId
    });

    workspace.role = 'owner';
    sendJSON(res, 201, workspace);
  } catch (err) {
    console.error('Create workspace error:', err);
    sendError(res, 500, 'Error creating workspace');
  }
}

async function handleGetWorkspaceDetails(req, res, id) {
  try {
    const { data: memCheck, error: memErr } = await supabase
      .from('workspace_members')
      .select('role, permissions')
      .eq('workspace_id', id)
      .eq('user_id', req.user.userId)
      .single();
      
    if (memErr || !memCheck) return sendError(res, 403, 'Not a member of this workspace');

    const { data: workspace, error: wsErr } = await supabase
      .from('workspaces')
      .select('*')
      .eq('id', id)
      .single();
      
    if (wsErr || !workspace) return sendError(res, 404, 'Workspace not found');

    const { data: channels } = await supabase
      .from('workspace_channels')
      .select('*')
      .eq('workspace_id', id)
      .order('created_at', { ascending: true });

    const { data: membersRes } = await supabase
      .from('workspace_members')
      .select('role, joined_at, users(id, display_name, username, avatar_url, public_key)')
      .eq('workspace_id', id);

    const members = (membersRes || []).map(m => ({
      ...m.users,
      role: m.role,
      joined_at: m.joined_at
    }));

    const response = {
      ...workspace,
      my_role: memCheck.role,
      channels: channels || [],
      members: members
    };
    sendJSON(res, 200, response);
  } catch (err) {
    console.error('Get workspace details error:', err);
    sendError(res, 500, 'Error getting workspace details');
  }
}

async function handleGenerateJoinCode(req, res, id) {
  try {
    const { data: checkRole } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', id)
      .eq('user_id', req.user.userId)
      .single();
      
    if (!checkRole || !['owner', 'admin'].includes(checkRole.role)) {
      return sendError(res, 403, 'Insufficient permissions');
    }

    const code = randomBytes(4).toString('hex');
    const { data, error } = await supabase
      .from('workspaces')
      .update({ join_code: code })
      .eq('id', id)
      .select('join_code')
      .single();
      
    if (error) return sendError(res, 500, error.message);
    sendJSON(res, 200, { join_code: data.join_code });
  } catch(err) {
    console.error('Generate join code error:', err);
    sendError(res, 500, 'Error generating join code');
  }
}

async function handleJoinWorkspaceWithCode(req, res, body) {
  const { code } = body;
  if (!code) return sendError(res, 400, 'Join code missing');

  try {
    const { data: workspace, error: wsErr } = await supabase
      .from('workspaces')
      .select('id')
      .eq('join_code', code)
      .single();
      
    if (wsErr || !workspace) return sendError(res, 404, 'Invalid join code');

    // On conflict do nothing is harder with Supabase client inserts, so we check first or just ignore duplicate error
    const { error: insErr } = await supabase
      .from('workspace_members')
      .insert({ workspace_id: workspace.id, user_id: req.user.userId });
      
    // Ignore 23505 (unique violation), otherwise throw
    if (insErr && insErr.code !== '23505') {
       console.error(insErr);
       return sendError(res, 500, 'Error joining workspace');
    }

    sendJSON(res, 200, { success: true, workspace_id: workspace.id });
  } catch(err) {
    console.error('Join workspace code error:', err);
    sendError(res, 500, 'Error joining workspace');
  }
}

async function handleGetChannelMessages(req, res, channelId) {
  try {
    const { data: chCheck, error: chErr } = await supabase
      .from('workspace_channels')
      .select('workspace_id, is_private')
      .eq('id', channelId)
      .single();
      
    if (chErr || !chCheck) return sendError(res, 404, 'Channel not found');

    const { workspace_id: wsId, is_private: isPrivate } = chCheck;

    const { data: memCheck, error: memErr } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', wsId)
      .eq('user_id', req.user.userId)
      .single();
      
    if (memErr || !memCheck) return sendError(res, 403, 'Not a member of this workspace');

    if (isPrivate) {
      const { data: pCheck } = await supabase
        .from('workspace_channel_members')
        .select('role')
        .eq('channel_id', channelId)
        .eq('user_id', req.user.userId)
        .single();
        
      if (!pCheck && !['owner', 'admin'].includes(memCheck.role)) {
        return sendError(res, 403, 'Not a member of this channel');
      }
    }

    const { data: msgs, error: msgErr } = await supabase
      .from('workspace_messages')
      .select('*, users(display_name, avatar_url)')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(100);
      
    if (msgErr) return sendError(res, 500, msgErr.message);

    const formatted = msgs.map(m => ({
      ...m,
      sender_name: m.users?.display_name,
      sender_avatar: m.users?.avatar_url,
      users: undefined
    })).reverse();

    sendJSON(res, 200, formatted);
  } catch (err) {
    console.error('Get channel messages error:', err);
    sendError(res, 500, 'Error getting channel messages');
  }
}

async function handleCreateChannel(req, res, workspaceId, body) {
  const { name, type, is_private } = body;
  try {
    const { data: memCheck } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.user.userId)
      .single();
      
    if (!memCheck || !['owner', 'admin'].includes(memCheck.role)) {
      return sendError(res, 403, 'Not allowed to create channels');
    }

    const { data: chRes, error: chErr } = await supabase
      .from('workspace_channels')
      .insert({
        workspace_id: workspaceId,
        name,
        type: type || 'text',
        is_private: is_private || false,
        created_by: req.user.userId
      })
      .select('*')
      .single();
      
    if (chErr) return sendError(res, 500, chErr.message);

    if (is_private) {
      await supabase.from('workspace_channel_members').insert({
        channel_id: chRes.id,
        user_id: req.user.userId,
        role: 'owner'
      });
    }

    sendJSON(res, 201, chRes);
  } catch(err) {
    console.error('Create channel error:', err);
    sendError(res, 500, 'Error creating channel');
  }
}

async function handleGetWorkspaceFiles(req, res, id) {
  try {
    const { data: memCheck } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', id)
      .eq('user_id', req.user.userId)
      .single();
      
    if (!memCheck) return sendError(res, 403, 'Not a member');

    const { data: msgs, error } = await supabase
      .from('workspace_messages')
      .select('*, users(display_name), workspace_channels!inner(workspace_id, name)')
      .eq('workspace_channels.workspace_id', id)
      .in('message_type', ['file', 'image', 'audio'])
      .order('created_at', { ascending: false });
      
    if (error) return sendError(res, 500, error.message);

    const formatted = msgs.map(m => ({
      id: m.id,
      name: m.file_name,
      size: m.file_size,
      media_url: m.media_url,
      type: m.message_type,
      created_at: m.created_at,
      uploader_name: m.users?.display_name,
      channel_name: m.workspace_channels?.name
    }));

    sendJSON(res, 200, formatted);
  } catch (err) {
    console.error('Get files error:', err);
    sendError(res, 500, 'Error getting workspace files');
  }
}

module.exports = {
  handleListWorkspaces,
  handleCreateWorkspace,
  handleGetWorkspaceDetails,
  handleGenerateJoinCode,
  handleJoinWorkspaceWithCode,
  handleGetChannelMessages,
  handleCreateChannel,
  handleGetWorkspaceFiles
};
