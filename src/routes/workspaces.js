const { pool } = require('../db');
const { sendJSON, sendError } = require('../utils/response');

async function handleListWorkspaces(req, res) {
  try {
    const result = await pool.query(`
      SELECT w.*, wm.role
      FROM workspaces w
      JOIN workspace_members wm ON w.id = wm.workspace_id
      WHERE wm.user_id = $1
      ORDER BY w.created_at DESC
    `, [req.user.id]);
    sendJSON(res, 200, result.rows);
  } catch (err) {
    console.error('List workspaces error:', err);
    sendError(res, 500, 'Error listing workspaces');
  }
}

async function handleCreateWorkspace(req, res, body) {
  const { name, description, avatar_url } = body;
  if (!name) return sendError(res, 400, 'Workspace name is required');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wsResult = await client.query(`
      INSERT INTO workspaces (name, description, avatar_url, owner_id)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [name, description, avatar_url, req.user.id]);
    const workspace = wsResult.rows[0];

    await client.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES ($1, $2, 'owner')
    `, [workspace.id, req.user.id]);

    await client.query(`
      INSERT INTO workspace_channels (workspace_id, name, type, created_by)
      VALUES ($1, 'general', 'text', $2)
    `, [workspace.id, req.user.id]);

    await client.query('COMMIT');
    workspace.role = 'owner';
    sendJSON(res, 201, workspace);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create workspace error:', err);
    sendError(res, 500, 'Error creating workspace');
  } finally {
    client.release();
  }
}

async function handleGetWorkspaceDetails(req, res, id) {
  try {
    // Check if member
    const memCheck = await pool.query(
      'SELECT role, permissions FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (memCheck.rows.length === 0) return sendError(res, 403, 'Not a member of this workspace');

    const wsResult = await pool.query('SELECT * FROM workspaces WHERE id = $1', [id]);
    if (wsResult.rows.length === 0) return sendError(res, 404, 'Workspace not found');

    const channelsRes = await pool.query(`
      SELECT * FROM workspace_channels
      WHERE workspace_id = $1
      ORDER BY created_at ASC
    `, [id]);

    const membersRes = await pool.query(`
      SELECT wm.role, wm.joined_at, u.id, u.display_name, u.username, u.avatar_url, u.public_key
      FROM workspace_members wm
      JOIN users u ON wm.user_id = u.id
      WHERE wm.workspace_id = $1
    `, [id]);

    const response = {
      ...wsResult.rows[0],
      my_role: memCheck.rows[0].role,
      channels: channelsRes.rows,
      members: membersRes.rows
    };
    sendJSON(res, 200, response);
  } catch (err) {
    console.error('Get workspace details error:', err);
    sendError(res, 500, 'Error getting workspace details');
  }
}

async function handleGenerateJoinCode(req, res, id) {
  try {
    const checkRole = await pool.query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [id, req.user.id]);
    if (checkRole.rows.length === 0 || !['owner', 'admin'].includes(checkRole.rows[0].role)) {
      return sendError(res, 403, 'Insufficient permissions');
    }

    const { randomBytes } = require('crypto');
    const code = randomBytes(4).toString('hex');
    const result = await pool.query('UPDATE workspaces SET join_code = $1 WHERE id = $2 RETURNING join_code', [code, id]);
    sendJSON(res, 200, { join_code: result.rows[0].join_code });
  } catch(err) {
    console.error('Generate join code error:', err);
    sendError(res, 500, 'Error generating join code');
  }
}

async function handleJoinWorkspaceWithCode(req, res, body) {
  const { code } = body;
  if (!code) return sendError(res, 400, 'Join code missing');

  try {
    const wsResult = await pool.query('SELECT id FROM workspaces WHERE join_code = $1', [code]);
    if (wsResult.rows.length === 0) return sendError(res, 404, 'Invalid join code');

    const wsId = wsResult.rows[0].id;
    await pool.query('INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [wsId, req.user.id]);
    
    sendJSON(res, 200, { success: true, workspace_id: wsId });
  } catch(err) {
    console.error('Join workspace code error:', err);
    sendError(res, 500, 'Error joining workspace');
  }
}

async function handleGetChannelMessages(req, res, channelId) {
  try {
    const chCheck = await pool.query('SELECT workspace_id, is_private FROM workspace_channels WHERE id = $1', [channelId]);
    if (chCheck.rows.length === 0) return sendError(res, 404, 'Channel not found');

    const wsId = chCheck.rows[0].workspace_id;
    const isPrivate = chCheck.rows[0].is_private;

    const memCheck = await pool.query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsId, req.user.id]);
    if (memCheck.rows.length === 0) return sendError(res, 403, 'Not a member of this workspace');

    if (isPrivate) {
      const pCheck = await pool.query('SELECT role FROM workspace_channel_members WHERE channel_id = $1 AND user_id = $2', [channelId, req.user.id]);
      if (pCheck.rows.length === 0 && !['owner', 'admin'].includes(memCheck.rows[0].role)) {
        return sendError(res, 403, 'Not a member of this channel');
      }
    }

    const msgs = await pool.query(`
      SELECT m.*, u.display_name as sender_name, u.avatar_url as sender_avatar
      FROM workspace_messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.channel_id = $1
      ORDER BY m.created_at DESC
      LIMIT 100
    `, [channelId]);

    sendJSON(res, 200, msgs.rows.reverse());
  } catch (err) {
    console.error('Get channel messages error:', err);
    sendError(res, 500, 'Error getting channel messages');
  }
}

async function handleCreateChannel(req, res, workspaceId, body) {
  const { name, type, is_private } = body;
  try {
    const memCheck = await pool.query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, req.user.id]);
    if (memCheck.rows.length === 0 || !['owner', 'admin'].includes(memCheck.rows[0].role)) {
      return sendError(res, 403, 'Not allowed to create channels');
    }

    const chRes = await pool.query(`
      INSERT INTO workspace_channels (workspace_id, name, type, is_private, created_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [workspaceId, name, type || 'text', is_private || false, req.user.id]);

    if (is_private) {
      await pool.query(`
        INSERT INTO workspace_channel_members (channel_id, user_id, role)
        VALUES ($1, $2, 'owner')
      `, [chRes.rows[0].id, req.user.id]);
    }

    sendJSON(res, 201, chRes.rows[0]);
  } catch(err) {
    console.error('Create channel error:', err);
    sendError(res, 500, 'Error creating channel');
  }
}

async function handleGetWorkspaceFiles(req, res, id) {
  try {
    const memCheck = await pool.query(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (memCheck.rows.length === 0) return sendError(res, 403, 'Not a member');

    const result = await pool.query(`
      SELECT m.id, m.file_name as name, m.file_size as size, m.media_url, m.message_type as type,
             m.created_at, u.display_name as uploader_name, c.name as channel_name
      FROM workspace_messages m
      JOIN users u ON m.sender_id = u.id
      JOIN workspace_channels c ON m.channel_id = c.id
      WHERE c.workspace_id = $1 AND m.message_type IN ('file', 'image', 'audio')
      ORDER BY m.created_at DESC
    `, [id]);
    sendJSON(res, 200, result.rows);
  } catch (err) {
    console.error('Get files error:', err);
    sendError(res, 500, 'Error getting workspace files');
  }
}

// Ensure module correctly exported
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
