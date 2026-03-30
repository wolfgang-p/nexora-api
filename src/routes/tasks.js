const supabase = require('../db/supabase');
const { sendJSON, sendError } = require('../utils/response');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// GET /tasks — fetch all tasks for current user
async function handleGetTasks(req, res) {
  const userId = req.user?.userId;
  const { workspace_id, list_id, status, is_ai_generated } = req.queryParams || {};

  let query = supabase
    .from('tasks')
    .select(`
      *,
      assigned_user:users!tasks_assigned_to_fkey(id, display_name, avatar_url),
      list:task_lists(id, name, color, icon)
    `)
    .eq('owner_id', userId)
    .order('position', { ascending: true });

  if (workspace_id) query = query.eq('workspace_id', workspace_id);
  if (list_id) query = query.eq('list_id', list_id);
  if (status) query = query.eq('status', status);
  if (is_ai_generated !== undefined) query = query.eq('is_ai_generated', is_ai_generated === 'true');

  const { data, error } = await query;
  if (error) { console.error('handleGetTasks error:', error); return sendError(res, 500, error.message); }
  return sendJSON(res, 200, data || []);
}

// GET /tasks/lists — fetch all task lists for current user
async function handleGetLists(req, res) {
  const userId = req.user?.userId;
  const { data, error } = await supabase
    .from('task_lists')
    .select('*, task_count:tasks(count)')
    .eq('owner_id', userId)
    .order('position', { ascending: true });

  if (error) { console.error('handleGetLists error:', error); return sendError(res, 500, error.message); }
  return sendJSON(res, 200, data || []);
}

// POST /tasks/lists — create a new list
async function handleCreateList(req, res, body) {
  const userId = req.user?.userId;
  const { name, color, icon } = body;
  if (!name) return sendError(res, 400, 'Name required');

  // Get max position
  const { data: existing } = await supabase
    .from('task_lists')
    .select('position')
    .eq('owner_id', userId)
    .order('position', { ascending: false })
    .limit(1);

  const position = existing?.[0]?.position !== undefined ? existing[0].position + 1 : 0;

  const { data, error } = await supabase
    .from('task_lists')
    .insert({ owner_id: userId, name, color: color || '#6B7280', icon: icon || 'list', position })
    .select()
    .single();

  if (error) { console.error('handleCreateList error:', error); return sendError(res, 500, error.message); }
  return sendJSON(res, 201, data);
}

// PUT /tasks/lists/:id — update a list
async function handleUpdateList(req, res, listId, body) {
  const userId = req.user?.userId;
  const { data, error } = await supabase
    .from('task_lists')
    .update(body)
    .eq('id', listId)
    .eq('owner_id', userId)
    .select()
    .single();

  if (error) { console.error('handleUpdateList error:', error); return sendError(res, 500, error.message); }
  return sendJSON(res, 200, data);
}

// DELETE /tasks/lists/:id — delete a list
async function handleDeleteList(req, res, listId) {
  const userId = req.user?.userId;
  const { error } = await supabase
    .from('task_lists')
    .delete()
    .eq('id', listId)
    .eq('owner_id', userId);

  if (error) { console.error('handleDeleteList error:', error); return sendError(res, 500, error.message); }
  return sendJSON(res, 200, { success: true });
}

// POST /tasks — create a task
async function handleCreateTask(req, res, body) {
  const userId = req.user?.userId;
  const {
    title, description, priority, status, due_date,
    list_id, workspace_id, conversation_id, assigned_to,
    is_ai_generated, source_message_id
  } = body;

  if (!title) return sendError(res, 400, 'Title required');

  // Get max position within list/workspace
  const posQuery = supabase
    .from('tasks')
    .select('position')
    .eq('owner_id', userId)
    .order('position', { ascending: false })
    .limit(1);

  const { data: existing } = await posQuery;
  const position = existing?.[0]?.position !== undefined ? existing[0].position + 1 : 0;

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      owner_id: userId,
      title,
      description: description || null,
      priority: priority || 'medium',
      status: status || 'todo',
      due_date: due_date || null,
      list_id: list_id || null,
      workspace_id: workspace_id || null,
      conversation_id: conversation_id || null,
      assigned_to: assigned_to || null,
      is_ai_generated: is_ai_generated || false,
      source_message_id: source_message_id || null,
      position
    })
    .select(`
      *,
      assigned_user:users!tasks_assigned_to_fkey(id, display_name, avatar_url),
      list:task_lists(id, name, color, icon)
    `)
    .single();

  if (error) { console.error('handleCreateTask error:', error); return sendError(res, 500, error.message); }
  return sendJSON(res, 201, data);
}

// PUT /tasks/:id — update a task
async function handleUpdateTask(req, res, taskId, body) {
  const userId = req.user?.userId;
  const { data, error } = await supabase
    .from('tasks')
    .update(body)
    .eq('id', taskId)
    .eq('owner_id', userId)
    .select(`
      *,
      assigned_user:users!tasks_assigned_to_fkey(id, display_name, avatar_url),
      list:task_lists(id, name, color, icon)
    `)
    .single();

  if (error) { console.error('handleUpdateTask error:', error); return sendError(res, 500, error.message); }
  return sendJSON(res, 200, data);
}

// DELETE /tasks/:id
async function handleDeleteTask(req, res, taskId) {
  const userId = req.user?.userId;
  const { error } = await supabase
    .from('tasks')
    .delete()
    .eq('id', taskId)
    .eq('owner_id', userId);

  if (error) { console.error('handleDeleteTask error:', error); return sendError(res, 500, error.message); }
  return sendJSON(res, 200, { success: true });
}

// PUT /tasks/reorder — bulk reorder tasks
async function handleReorderTasks(req, res, body) {
  const userId = req.user?.userId;
  const { items } = body; // [{ id, position }]
  if (!items || !Array.isArray(items)) return sendError(res, 400, 'items array required');

  const updates = items.map(({ id, position }) =>
    supabase.from('tasks').update({ position }).eq('id', id).eq('owner_id', userId)
  );

  await Promise.all(updates);
  return sendJSON(res, 200, { success: true });
}

// POST /tasks/ai-extract — extract tasks from message content using OpenAI
async function handleAIExtract(req, res, body) {
  const userId = req.user?.userId;
  const { content, source_message_id, conversation_id, workspace_id } = body;

  if (!content) return sendError(res, 400, 'Content required');
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'YOUR_OPENAI_API_KEY_HERE') {
    return sendError(res, 503, 'OpenAI API not configured');
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a task extraction assistant. Analyze the given message and extract actionable tasks or to-dos mentioned in it.
Return a JSON array of tasks. Each task has:
- title (string, max 80 chars, concise action verb + object)
- description (string, brief context from message, max 200 chars)
- priority ("low", "medium", "high") — infer from urgency keywords  
- due_date (ISO date string if a date is mentioned, otherwise null)

Return ONLY a valid JSON array, no markdown, no explanation. If no tasks found, return [].`
        },
        {
          role: 'user',
          content: content
        }
      ],
      max_tokens: 512,
      temperature: 0.3
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '[]';
    let tasks = [];
    try { tasks = JSON.parse(raw); } catch { tasks = []; }

    // Save AI-extracted tasks to DB
    const saved = [];
    for (const t of tasks) {
      const { data: existing } = await supabase
        .from('tasks')
        .select('position')
        .eq('owner_id', userId)
        .order('position', { ascending: false })
        .limit(1);

      const position = existing?.[0]?.position !== undefined ? existing[0].position + 1 : 0;

      const { data } = await supabase
        .from('tasks')
        .insert({
          owner_id: userId,
          title: t.title,
          description: t.description || null,
          priority: t.priority || 'medium',
          status: 'todo',
          due_date: t.due_date || null,
          is_ai_generated: true,
          source_message_id: source_message_id || null,
          conversation_id: conversation_id || null,
          workspace_id: workspace_id || null,
          position
        })
        .select()
        .single();

      if (data) saved.push(data);
    }

    return sendJSON(res, 200, { tasks: saved, count: saved.length });
  } catch (err) {
    console.error('AI Extract Error:', err);
    return sendError(res, 500, 'AI extraction failed');
  }
}

// POST /tasks/ai-detect — detect task in text WITHOUT saving (for E2EE chats client-side use)
async function handleAIDetect(req, res, body) {
  const { content } = body;
  if (!content || content.length < 10) return sendJSON(res, 200, null);
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'YOUR_OPENAI_API_KEY_HERE') {
    return sendJSON(res, 200, null);
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Du bist ein Task-Erkennungsassistent. Erkenne NUR klare Aufgaben oder To-Dos.
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt oder dem Wort null.
Format: {"title":"...","priority":"low|medium|high","for":"sender|recipient"}
"for"="sender" wenn Sender selbst etwas tun will, "recipient" wenn Empf\u00e4nger.
Beispiele: "Ich muss noch einkaufen" \u2192 {"title":"Einkaufen","priority":"medium","for":"sender"}
"Schickst du mir die Datei?" \u2192 {"title":"Datei schicken","priority":"medium","for":"recipient"}
"Wie geht es dir?" \u2192 null`
        },
        { role: 'user', content }
      ],
      max_tokens: 80,
      temperature: 0.1
    });

    const raw = (completion.choices[0]?.message?.content || '').trim();
    if (!raw || raw === 'null') return sendJSON(res, 200, null);

    let task;
    try { task = JSON.parse(raw); } catch { return sendJSON(res, 200, null); }
    if (!task?.title) return sendJSON(res, 200, null);

    return sendJSON(res, 200, { title: task.title, priority: task.priority || 'medium', for: task.for });
  } catch (err) {
    console.warn('AI Detect error:', err.message);
    return sendJSON(res, 200, null);
  }
}

module.exports = {
  handleGetTasks,
  handleGetLists,
  handleCreateList,
  handleUpdateList,
  handleDeleteList,
  handleCreateTask,
  handleUpdateTask,
  handleDeleteTask,
  handleReorderTasks,
  handleAIExtract,
  handleAIDetect
};
