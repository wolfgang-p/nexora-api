-- =============================================================================
-- Koro — RLS policies (per-table)
-- =============================================================================
-- Assumes the API layer sets the session context per request:
--   SET LOCAL koro.user_id = '<uuid>';
--   SET LOCAL koro.device_id = '<uuid>';
--   (optional) SET LOCAL koro.api_key_id = '<uuid>';
--
-- The service_role key bypasses RLS entirely, so the backend can still do
-- anything. These policies protect against a leaked anon key or a misconfigured
-- Supabase client that ends up talking straight to PostgREST.
-- =============================================================================

BEGIN;

-- --------- Helpers ------------------------------------------------------------

CREATE OR REPLACE FUNCTION koro.auth_uid() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('koro.user_id', TRUE), '')::UUID;
$$;

CREATE OR REPLACE FUNCTION koro.auth_device() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('koro.device_id', TRUE), '')::UUID;
$$;

-- The helpers live in schema `koro`; create it if missing.
CREATE SCHEMA IF NOT EXISTS koro;
GRANT USAGE ON SCHEMA koro TO PUBLIC;
-- Re-create after schema exists (no-op on re-run):
CREATE OR REPLACE FUNCTION koro.auth_uid() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('koro.user_id', TRUE), '')::UUID;
$$;

CREATE OR REPLACE FUNCTION koro.auth_device() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('koro.device_id', TRUE), '')::UUID;
$$;

CREATE OR REPLACE FUNCTION koro.is_conv_member(cid UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversation_members
    WHERE conversation_id = cid
      AND user_id = koro.auth_uid()
      AND left_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION koro.is_ws_member(wid UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = wid
      AND user_id = koro.auth_uid()
      AND left_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION koro.is_ws_admin(wid UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = wid
      AND user_id = koro.auth_uid()
      AND left_at IS NULL
      AND role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION koro.is_conv_admin(cid UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversation_members
    WHERE conversation_id = cid
      AND user_id = koro.auth_uid()
      AND left_at IS NULL
      AND role IN ('owner', 'admin')
  );
$$;

-- --------- users --------------------------------------------------------------

CREATE POLICY users_self_select ON users
  FOR SELECT USING (id = koro.auth_uid());

-- Allow looking up other users (search, profile view) but only public fields.
-- Enforce column scope in the API; Postgres RLS can't column-filter cleanly.
CREATE POLICY users_public_lookup ON users
  FOR SELECT USING (deleted_at IS NULL);

CREATE POLICY users_self_update ON users
  FOR UPDATE USING (id = koro.auth_uid())
              WITH CHECK (id = koro.auth_uid());

-- --------- devices ------------------------------------------------------------

-- Users see their own devices...
CREATE POLICY devices_self_select ON devices
  FOR SELECT USING (user_id = koro.auth_uid());

-- ...and the public-key part of devices belonging to people they share a
-- conversation with (so they can encrypt fanout).
CREATE POLICY devices_copeer_select ON devices
  FOR SELECT USING (
    revoked_at IS NULL AND EXISTS (
      SELECT 1 FROM conversation_members me
      JOIN conversation_members peer USING (conversation_id)
      WHERE me.user_id = koro.auth_uid()
        AND me.left_at IS NULL
        AND peer.left_at IS NULL
        AND peer.user_id = devices.user_id
    )
  );

CREATE POLICY devices_self_insert ON devices
  FOR INSERT WITH CHECK (user_id = koro.auth_uid());

CREATE POLICY devices_self_update ON devices
  FOR UPDATE USING (user_id = koro.auth_uid())
              WITH CHECK (user_id = koro.auth_uid());

-- --------- sessions -----------------------------------------------------------

CREATE POLICY sessions_self_all ON sessions
  FOR ALL USING (user_id = koro.auth_uid())
          WITH CHECK (user_id = koro.auth_uid());

-- --------- workspaces ---------------------------------------------------------

CREATE POLICY workspaces_member_select ON workspaces
  FOR SELECT USING (
    deleted_at IS NULL AND koro.is_ws_member(id)
  );

CREATE POLICY workspaces_admin_update ON workspaces
  FOR UPDATE USING (koro.is_ws_admin(id))
              WITH CHECK (koro.is_ws_admin(id));

CREATE POLICY workspaces_creator_insert ON workspaces
  FOR INSERT WITH CHECK (created_by = koro.auth_uid());

CREATE POLICY workspace_members_member_select ON workspace_members
  FOR SELECT USING (koro.is_ws_member(workspace_id));

CREATE POLICY workspace_members_admin_write ON workspace_members
  FOR ALL USING (koro.is_ws_admin(workspace_id))
          WITH CHECK (koro.is_ws_admin(workspace_id));

-- --------- conversations -----------------------------------------------------

CREATE POLICY conversations_member_select ON conversations
  FOR SELECT USING (deleted_at IS NULL AND koro.is_conv_member(id));

CREATE POLICY conversations_creator_insert ON conversations
  FOR INSERT WITH CHECK (created_by = koro.auth_uid());

CREATE POLICY conversations_admin_update ON conversations
  FOR UPDATE USING (koro.is_conv_admin(id))
              WITH CHECK (koro.is_conv_admin(id));

CREATE POLICY conv_members_member_select ON conversation_members
  FOR SELECT USING (koro.is_conv_member(conversation_id));

CREATE POLICY conv_members_self_update ON conversation_members
  FOR UPDATE USING (user_id = koro.auth_uid())
              WITH CHECK (user_id = koro.auth_uid());

CREATE POLICY conv_members_admin_write ON conversation_members
  FOR ALL USING (koro.is_conv_admin(conversation_id))
          WITH CHECK (koro.is_conv_admin(conversation_id));

-- --------- messages -----------------------------------------------------------

CREATE POLICY messages_conv_member_select ON messages
  FOR SELECT USING (koro.is_conv_member(conversation_id));

CREATE POLICY messages_sender_insert ON messages
  FOR INSERT WITH CHECK (
    sender_user_id = koro.auth_uid()
    AND koro.is_conv_member(conversation_id)
  );

CREATE POLICY messages_sender_delete ON messages
  FOR UPDATE USING (sender_user_id = koro.auth_uid() OR koro.is_conv_admin(conversation_id))
              WITH CHECK (TRUE);

-- --------- message_recipients ------------------------------------------------
-- A device can see only rows addressed to it (i.e. its own ciphertexts),
-- but the sender can insert for any member device of the conversation.

CREATE POLICY mr_recipient_select ON message_recipients
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = message_recipients.recipient_device_id
        AND d.user_id = koro.auth_uid()
    )
  );

CREATE POLICY mr_sender_insert ON message_recipients
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = message_recipients.message_id
        AND m.sender_user_id = koro.auth_uid()
    )
  );

CREATE POLICY mr_recipient_update ON message_recipients
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = message_recipients.recipient_device_id
        AND d.user_id = koro.auth_uid()
    )
  );

-- --------- reactions ----------------------------------------------------------

CREATE POLICY reactions_conv_member_select ON message_reactions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = message_reactions.message_id
        AND koro.is_conv_member(m.conversation_id)
    )
  );

CREATE POLICY reactions_self_write ON message_reactions
  FOR ALL USING (user_id = koro.auth_uid())
          WITH CHECK (user_id = koro.auth_uid());

-- --------- media --------------------------------------------------------------

CREATE POLICY media_conv_member_select ON media_objects
  FOR SELECT USING (
    conversation_id IS NULL OR koro.is_conv_member(conversation_id)
  );

CREATE POLICY media_uploader_insert ON media_objects
  FOR INSERT WITH CHECK (uploader_user_id = koro.auth_uid());

CREATE POLICY media_recipients_self_select ON media_recipients
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = media_recipients.recipient_device_id
        AND d.user_id = koro.auth_uid()
    )
  );

CREATE POLICY media_recipients_uploader_insert ON media_recipients
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM media_objects mo
      WHERE mo.id = media_recipients.media_object_id
        AND mo.uploader_user_id = koro.auth_uid()
    )
  );

-- --------- calls --------------------------------------------------------------

CREATE POLICY calls_conv_member_select ON calls
  FOR SELECT USING (koro.is_conv_member(conversation_id));

CREATE POLICY calls_initiator_insert ON calls
  FOR INSERT WITH CHECK (initiator_user_id = koro.auth_uid());

CREATE POLICY call_participants_self_all ON call_participants
  FOR ALL USING (user_id = koro.auth_uid())
          WITH CHECK (user_id = koro.auth_uid());

-- --------- tasks --------------------------------------------------------------

CREATE POLICY tasks_visible ON tasks
  FOR SELECT USING (
    deleted_at IS NULL AND (
      creator_user_id = koro.auth_uid()
      OR assignee_user_id = koro.auth_uid()
      OR (workspace_id IS NOT NULL AND koro.is_ws_member(workspace_id))
    )
  );

CREATE POLICY tasks_creator_write ON tasks
  FOR ALL USING (
    creator_user_id = koro.auth_uid()
    OR assignee_user_id = koro.auth_uid()
    OR (workspace_id IS NOT NULL AND koro.is_ws_admin(workspace_id))
  )
  WITH CHECK (
    creator_user_id = koro.auth_uid()
    OR (workspace_id IS NOT NULL AND koro.is_ws_admin(workspace_id))
  );

CREATE POLICY task_lists_visible ON task_lists
  FOR SELECT USING (
    deleted_at IS NULL AND (
      owner_user_id = koro.auth_uid()
      OR (workspace_id IS NOT NULL AND koro.is_ws_member(workspace_id))
    )
  );

CREATE POLICY task_lists_write ON task_lists
  FOR ALL USING (
    owner_user_id = koro.auth_uid()
    OR (workspace_id IS NOT NULL AND koro.is_ws_admin(workspace_id))
  )
  WITH CHECK (
    owner_user_id = koro.auth_uid()
    OR (workspace_id IS NOT NULL AND koro.is_ws_admin(workspace_id))
  );

CREATE POLICY checklist_inherit ON task_checklist_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM tasks t WHERE t.id = task_checklist_items.task_id
        AND (t.creator_user_id = koro.auth_uid()
             OR t.assignee_user_id = koro.auth_uid()
             OR (t.workspace_id IS NOT NULL AND koro.is_ws_member(t.workspace_id)))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tasks t WHERE t.id = task_checklist_items.task_id
        AND (t.creator_user_id = koro.auth_uid()
             OR (t.workspace_id IS NOT NULL AND koro.is_ws_admin(t.workspace_id)))
    )
  );

-- --------- blocks -------------------------------------------------------------

CREATE POLICY blocks_self_all ON blocks
  FOR ALL USING (blocker_user_id = koro.auth_uid())
          WITH CHECK (blocker_user_id = koro.auth_uid());

-- --------- settings & push tokens --------------------------------------------

CREATE POLICY user_settings_self ON user_settings
  FOR ALL USING (user_id = koro.auth_uid())
          WITH CHECK (user_id = koro.auth_uid());

CREATE POLICY push_tokens_self ON push_tokens
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = push_tokens.device_id
        AND d.user_id = koro.auth_uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = push_tokens.device_id
        AND d.user_id = koro.auth_uid()
    )
  );

-- --------- api_keys, webhooks, audit (workspace-admin only) ------------------

CREATE POLICY api_keys_admin ON api_keys
  FOR ALL USING (koro.is_ws_admin(workspace_id))
          WITH CHECK (koro.is_ws_admin(workspace_id));

CREATE POLICY webhooks_admin ON webhooks
  FOR ALL USING (koro.is_ws_admin(workspace_id))
          WITH CHECK (koro.is_ws_admin(workspace_id));

CREATE POLICY webhook_deliveries_admin ON webhook_deliveries
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM webhooks w
      WHERE w.id = webhook_deliveries.webhook_id
        AND koro.is_ws_admin(w.workspace_id)
    )
  );

CREATE POLICY audit_workspace_admin ON audit_events
  FOR SELECT USING (
    (workspace_id IS NOT NULL AND koro.is_ws_admin(workspace_id))
    OR actor_user_id = koro.auth_uid()
  );

COMMIT;
