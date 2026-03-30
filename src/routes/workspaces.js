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
  console.log(`[WorkspaceCreate] Attempting to create workspace for user ${req.user.userId}`, body);

  if (!name) {
    console.error('[WorkspaceCreate] Failed: Workspace name is missing');
    return sendError(res, 400, 'Workspace name is required');
  }
  
  try {
    console.log('[WorkspaceCreate] Inserting into workspaces table...');
    const { data: workspace, error: wsError } = await supabase
      .from('workspaces')
      .insert({ 
        name, 
        description: description || null, 
        avatar_url: avatar_url || null, 
        owner_id: req.user.userId 
      })
      .select('*')
      .single();
      
    if (wsError) {
      console.error('[WorkspaceCreate] Workspaces insert error:', wsError);
      return sendError(res, 500, wsError.message);
    }
    console.log('[WorkspaceCreate] Workspaces insert success:', workspace.id);

    console.log('[WorkspaceCreate] Inserting owner into workspace_members...');
    const { error: memError } = await supabase.from('workspace_members').insert({
      workspace_id: workspace.id,
      user_id: req.user.userId,
      role: 'owner'
    });
    
    if (memError) {
      console.error('[WorkspaceCreate] workspace_members insert error:', memError);
      return sendError(res, 500, memError.message);
    }
    console.log('[WorkspaceCreate] workspace_members insert success');

    console.log('[WorkspaceCreate] Creating general channel...');
    const { error: chanError } = await supabase.from('workspace_channels').insert({
      workspace_id: workspace.id,
      name: 'general',
      type: 'text',
      created_by: req.user.userId
    });
    
    if (chanError) {
      console.error('[WorkspaceCreate] workspace_channels insert error:', chanError);
      return sendError(res, 500, chanError.message);
    }
    console.log('[WorkspaceCreate] workspace_channels insert success');

    workspace.role = 'owner';
    console.log('[WorkspaceCreate] Success! Returning workspace details.');
    sendJSON(res, 201, workspace);
  } catch (err) {
    console.error('[WorkspaceCreate] Catch block error:', err);
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

async function handleUpdateWorkspace(req, res, id, body) {
  try {
    const { data: memCheck } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', id)
      .eq('user_id', req.user.userId)
      .single();
      
    if (!memCheck || !['owner', 'admin'].includes(memCheck.role)) {
      return sendError(res, 403, 'Insufficient permissions');
    }

    const updates = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.avatar_url !== undefined) updates.avatar_url = body.avatar_url;
    if (body.announcement !== undefined) updates.announcement = body.announcement;

    if (Object.keys(updates).length === 0) return sendError(res, 400, 'No updates provided');

    const { data, error } = await supabase
      .from('workspaces')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return sendError(res, 500, error.message);
    sendJSON(res, 200, data);
  } catch(err) {
    console.error('Update workspace error:', err);
    sendError(res, 500, 'Error updating workspace');
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

async function handleDeleteWorkspace(req, res, id) {
  try {
    const { data: memCheck } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', id)
      .eq('user_id', req.user.userId)
      .single();
      
    if (!memCheck || memCheck.role !== 'owner') {
      return sendError(res, 403, 'Nur der Besitzer kann den Arbeitsbereich löschen.');
    }

    const { error } = await supabase
      .from('workspaces')
      .delete()
      .eq('id', id);

    if (error) return sendError(res, 500, error.message);
    sendJSON(res, 200, { success: true });
  } catch(err) {
    console.error('Delete workspace error:', err);
    sendError(res, 500, 'Error deleting workspace');
  }
}

async function handleUpdateChannel(req, res, workspaceId, channelId, body) {
  const { name } = body;
  try {
    const { data: memCheck } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.user.userId)
      .single();
      
    if (!memCheck || !['owner', 'admin'].includes(memCheck.role)) {
      return sendError(res, 403, 'Fehlende Berechtigung zum Bearbeiten von Kanälen');
    }

    const { data: chRes, error: chErr } = await supabase
      .from('workspace_channels')
      .update({ name })
      .eq('id', channelId)
      .eq('workspace_id', workspaceId)
      .select('*')
      .single();
      
    if (chErr) return sendError(res, 500, chErr.message);

    sendJSON(res, 200, chRes);
  } catch(err) {
    console.error('Update channel error:', err);
    sendError(res, 500, 'Error updating channel');
  }
}

async function handleDeleteChannel(req, res, workspaceId, channelId) {
  try {
    const { data: memCheck } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.user.userId)
      .single();
      
    if (!memCheck || !['owner', 'admin'].includes(memCheck.role)) {
      return sendError(res, 403, 'Fehlende Berechtigung zum Löschen von Kanälen');
    }

    const { error } = await supabase
      .from('workspace_channels')
      .delete()
      .eq('id', channelId)
      .eq('workspace_id', workspaceId);

    if (error) return sendError(res, 500, error.message);
    sendJSON(res, 200, { success: true });
  } catch(err) {
    console.error('Delete channel error:', err);
    sendError(res, 500, 'Error deleting channel');
  }
}

async function handleUpdateMemberRole(req, res, workspaceId, targetUserId, body) {
  const { role } = body;
  try {
    if (!['admin', 'member', 'guest'].includes(role)) {
      return sendError(res, 400, 'Ungültige Rolle');
    }

    const { data: myMember } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.user.userId)
      .single();

    if (!myMember || myMember.role !== 'owner') {
      return sendError(res, 403, 'Nur der Besitzer darf Rollen ändern');
    }

    const { data: targetMember } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', targetUserId)
      .single();

    if (!targetMember) return sendError(res, 404, 'Benutzer nicht im Arbeitsbereich');
    if (targetMember.role === 'owner') return sendError(res, 400, 'Besitzer-Rolle kann nicht geändert werden');

    const { error } = await supabase
      .from('workspace_members')
      .update({ role })
      .eq('workspace_id', workspaceId)
      .eq('user_id', targetUserId);

    if (error) return sendError(res, 500, error.message);
    sendJSON(res, 200, { success: true, role });
  } catch (err) {
    console.error('Update member role err:', err);
    sendError(res, 500, 'Error updating member role');
  }
}

async function handleRemoveMember(req, res, workspaceId, targetUserId) {
  try {
    const { data: myMember } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.user.userId)
      .single();

    if (!myMember || !['owner', 'admin'].includes(myMember.role)) {
      return sendError(res, 403, 'Fehlende Berechtigung (Admin oder Owner erforderlich)');
    }

    if (req.user.userId === targetUserId) {
      return sendError(res, 400, 'Du kannst dich nicht selbst entfernen');
    }

    const { data: targetMember } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', targetUserId)
      .single();

    if (!targetMember) return sendError(res, 404, 'Benutzer nicht gefunden');
    if (targetMember.role === 'owner') return sendError(res, 403, 'Besitzer können nicht entfernt werden');
    if (myMember.role === 'admin' && targetMember.role === 'admin') {
      return sendError(res, 403, 'Admins können keine anderen Admins entfernen');
    }

    const { error } = await supabase
      .from('workspace_members')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('user_id', targetUserId);

    if (error) return sendError(res, 500, error.message);
    sendJSON(res, 200, { success: true });
  } catch (err) {
    console.error('Remove member err:', err);
    sendError(res, 500, 'Error removing member');
  }
}

module.exports = {
  handleListWorkspaces,
  handleCreateWorkspace,
  handleGetWorkspaceDetails,
  handleUpdateWorkspace,
  handleGenerateJoinCode,
  handleJoinWorkspaceWithCode,
  handleGetChannelMessages,
  handleCreateChannel,
  handleGetWorkspaceFiles,
  handleDeleteWorkspace,
  handleUpdateChannel,
  handleDeleteChannel,
  handleUpdateMemberRole,
  handleRemoveMember
};
