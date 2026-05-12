// TidyAI — MVP app logic
// Storage keys
const LS = {
  key: 'tidyai_openai_key',
  model: 'tidyai_model',
  family: 'tidyai_family',
  tasks: 'tidyai_tasks',
  lastScan: 'tidyai_last_scan',
};

// Palette for family avatars
const PALETTE = ['#7c5cff', '#29d3a3', '#ffb547', '#ff5d73', '#5eb8ff', '#f78bff', '#ffd166', '#06d6a0'];

// --- State ---
const state = {
  imageDataUrl: null,
  scan: null,           // { score, summary, items: [...] }
  family: load(LS.family, []),
  tasks: load(LS.tasks, []),
  filter: 'all',        // 'all' | memberId | 'quickwin' | 'done'
};

function load(k, fallback) {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
}
function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

// --- Boot ---
window.addEventListener('DOMContentLoaded', () => {
  // Restore last scan
  const last = load(LS.lastScan, null);
  if (last) {
    state.scan = last;
    renderScanResults();
  }
  // Restore settings UI
  document.getElementById('api-key-input').value = localStorage.getItem(LS.key) || '';
  document.getElementById('model-select').value = localStorage.getItem(LS.model) || 'gpt-4o-mini';
  updateApiBadge();
  // File input wiring (gallery + camera)
  document.getElementById('file-input').addEventListener('change', onFileChosen);
  const cam = document.getElementById('camera-input');
  if (cam) cam.addEventListener('change', onFileChosen);
  renderFamily();
  renderTasks();
});

// --- Tabs ---
function switchTab(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  if (name === 'tasks') renderTasks();
  if (name === 'family') renderFamily();
}

// --- Toast ---
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// --- API key badge ---
function updateApiBadge() {
  const b = document.getElementById('api-badge');
  const has = !!localStorage.getItem(LS.key);
  b.textContent = has ? 'API connected' : 'No API key';
  b.style.color = has ? '#29d3a3' : '';
  b.style.borderColor = has ? 'rgba(41,211,163,0.4)' : '';
}

// --- File handling ---
function onFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  toast('Loading photo…');

  // Set imageDataUrl as soon as the file is read — analyze works even if
  // canvas downscale or preview rendering fails.
  const reader = new FileReader();
  reader.onerror = () => toast('Could not read that file');
  reader.onload = () => {
    const dataUrl = reader.result;
    state.imageDataUrl = dataUrl; // immediate fallback

    // Try to render the preview and downscale for cheaper API calls.
    const preview = document.getElementById('preview-img');
    preview.onerror = () => { preview.style.display = 'none'; };
    preview.onload = () => { preview.style.display = 'block'; };
    preview.src = dataUrl;
    document.getElementById('upload-placeholder').style.display = 'none';

    // Downscale in background; replace imageDataUrl if it succeeds.
    const img = new Image();
    img.onload = () => {
      try {
        const maxDim = 1024;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        state.imageDataUrl = canvas.toDataURL('image/jpeg', 0.85);
      } catch (err) {
        console.warn('Canvas downscale failed, using original', err);
      }
    };
    img.onerror = () => console.warn('Image decode failed, sending original (likely HEIC)');
    img.src = dataUrl;

    toast('Photo ready — tap Analyze');
  };
  reader.readAsDataURL(file);
  // Reset the input so picking the same file twice still triggers change
  e.target.value = '';
}

// --- Analyze (OpenAI Vision) ---
async function analyzePhoto() {
  if (!state.imageDataUrl) return toast('Add a photo first');
  const key = localStorage.getItem(LS.key);
  if (!key) {
    toast('Add your OpenAI API key in Settings');
    switchTab('settings');
    return;
  }
  const model = localStorage.getItem(LS.model) || 'gpt-4o-mini';

  const btn = document.getElementById('analyze-btn');
  const label = document.getElementById('analyze-label');
  btn.disabled = true;
  label.innerHTML = '<span class="spinner"></span> Analyzing…';

  const systemPrompt = `You are TidyAI, a warm and encouraging home-tidying coach. The user uploads a photo of a room.
Return STRICT JSON with this shape:
{
  "cleanliness_score": <0-100 integer, where 100 is spotless>,
  "summary": "<one warm, encouraging sentence — never shaming, never comparing to ideal homes>",
  "room_type": "<e.g. living room, bedroom, kitchen>",
  "items": [
    {
      "id": "<short slug>",
      "title": "<imperative task, max 8 words, names the actual object>",
      "object": "<the specific visible thing the user can see, e.g. 'blue mug on desk', 'laundry pile by closet', 'cables under TV'>",
      "why": "<one short sentence on visible impact>",
      "minutes": <integer 1-15>,
      "priority": "high" | "medium" | "low",
      "quick_win": <true if doing this in <=60s gives a big visible improvement>
    }
  ]
}
HARD RULES:
- 4 to 8 items total.
- Include 2-4 quick_win items whose minutes sum to ~3.
- The "object" field MUST name a specific item you can actually see in this photo (color, location, or descriptor). NEVER use generic phrases like "surfaces", "clutter", "items", "things". If you can't name a specific object, omit the item.
- The "title" should reference the object: "Move the blue mug to the kitchen", not "Tidy surfaces".
- Prioritize visible clutter, surfaces, and floor over deep cleaning.
- Tone: encouraging and matter-of-fact. Never shame ("you really should"), never urgency ("ASAP", "overdue"), never compare to other homes.
- Never make assumptions about the user's living situation, mental state, or finances based on what you see.
- Output ONLY the JSON object, no markdown, no commentary.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this room and give me a 3-minute quick-clean plan plus a full task list.' },
              { type: 'image_url', image_url: { url: state.imageDataUrl, detail: 'low' } },
            ],
          },
        ],
        max_tokens: 800,
        temperature: 0.4,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error('OpenAI error: ' + res.status + ' — ' + errText.slice(0, 200));
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    state.scan = parsed;
    save(LS.lastScan, parsed);
    renderScanResults();
    toast('Room analyzed!');
  } catch (err) {
    console.error(err);
    toast(err.message.length < 80 ? err.message : 'Analysis failed — see console');
  } finally {
    btn.disabled = false;
    label.textContent = 'Analyze';
  }
}

// --- Breakdown into micro-steps (ADHD-friendly) ---
async function breakdownTask(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  // If already broken down, just toggle expansion
  if (task.microSteps && task.microSteps.length) {
    task.microStepsExpanded = !task.microStepsExpanded;
    save(LS.tasks, state.tasks);
    renderTasks();
    return;
  }
  const key = localStorage.getItem(LS.key);
  if (!key) {
    toast('Add your OpenAI API key in Settings');
    switchTab('settings');
    return;
  }
  const model = localStorage.getItem(LS.model) || 'gpt-4o-mini';

  task._breakingDown = true;
  renderTasks();

  const systemPrompt = `You break a single home-tidying task into concrete physical micro-steps the user can start right now.
Return STRICT JSON with this shape:
{
  "steps": [
    { "id": "<short slug>", "title": "<imperative, max 12 words>", "seconds": <integer 15-90> }
  ]
}
HARD RULES:
- Between 3 and 7 steps. Past 7, cognitive load goes back up — never exceed.
- Each step seconds <= 90.
- Order so the most visually-impactful step is FIRST (user gets dopamine early).
- Use concrete physical actions ("Put loose items on desk into a basket"), never vague verbs ("tidy", "organize").
- No shame language, no urgency, no comparisons.
- Output ONLY the JSON object, no markdown.`;

  const userText = `Task: "${task.title}"${task.object ? ` (about: ${task.object})` : ''}${task.why ? `. Why: ${task.why}` : ''}. Break this into micro-steps.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        max_tokens: 400,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('OpenAI error: ' + res.status + ' — ' + errText.slice(0, 200));
    }
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    const steps = (parsed.steps || []).slice(0, 7).map(s => ({
      id: s.id || 's_' + Math.random().toString(36).slice(2, 6),
      title: s.title || '',
      seconds: Math.max(15, Math.min(90, parseInt(s.seconds) || 60)),
      done: false,
    }));
    task.microSteps = steps;
    task.microStepsExpanded = true;
    save(LS.tasks, state.tasks);
  } catch (err) {
    console.error(err);
    toast(err.message.length < 80 ? err.message : 'Could not break it down — see console');
  } finally {
    delete task._breakingDown;
    renderTasks();
  }
}

function toggleMicroStep(taskId, stepId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !task.microSteps) return;
  const step = task.microSteps.find(s => s.id === stepId);
  if (!step) return;
  step.done = !step.done;
  // If every step is done, auto-complete the parent task
  if (task.microSteps.every(s => s.done) && !task.done) {
    task.done = true;
    toast('Nice — task done!');
  }
  save(LS.tasks, state.tasks);
  renderTasks();
  renderFamily();
}

// --- Render scan results ---
function renderScanResults() {
  if (!state.scan) return;
  document.getElementById('scan-results').style.display = 'block';
  const { cleanliness_score = 0, summary = '', items = [], room_type = '' } = state.scan;
  const ring = document.getElementById('score-ring');
  ring.style.setProperty('--p', Math.max(0, Math.min(100, cleanliness_score)));
  document.getElementById('score-num').textContent = cleanliness_score;
  document.getElementById('score-label').textContent = room_type ? capitalize(room_type) : 'Cleanliness';
  document.getElementById('score-summary').textContent = summary;

  // Quick-win plan
  const quickWins = items.filter(i => i.quick_win);
  const qpCard = document.getElementById('quickplan-card');
  const qpList = document.getElementById('quickplan-list');
  qpList.innerHTML = '';
  if (quickWins.length) {
    qpCard.style.display = 'block';
    const totalMins = quickWins.reduce((s, i) => s + (i.minutes || 1), 0);
    document.getElementById('quickplan-time').textContent = formatMinutes(totalMins);
    quickWins.forEach(item => qpList.appendChild(renderItemRow(item, true)));
  } else {
    qpCard.style.display = 'none';
  }

  // All suggestions
  const list = document.getElementById('suggested-list');
  list.innerHTML = '';
  items.forEach(item => list.appendChild(renderItemRow(item, false)));
}

function renderItemRow(item, isQuickWin) {
  const li = document.createElement('li');
  li.className = 'task';
  const alreadyAdded = state.tasks.some(t => t.sourceId === item.id);
  li.innerHTML = `
    <div class="task-body">
      <div class="task-title">${escapeHtml(item.title)}</div>
      ${item.object ? `<div style="font-size:12px;color:var(--accent-2);margin-top:2px">👁 ${escapeHtml(item.object)}</div>` : ''}
      <div class="task-meta" style="margin-top:6px">
        <span class="chip priority-${item.priority || 'low'}">${item.priority || 'low'}</span>
        <span class="chip">⏱ ${item.minutes || 1} min</span>
        ${isQuickWin ? '<span class="chip" style="color:var(--accent-2)">quick win</span>' : ''}
      </div>
      ${item.why ? `<div style="color:var(--muted);font-size:12px;margin-top:6px">${escapeHtml(item.why)}</div>` : ''}
    </div>
    <button class="btn small ${alreadyAdded ? 'ghost' : 'secondary'}" ${alreadyAdded ? 'disabled' : ''}>
      ${alreadyAdded ? 'Added' : '+ Add'}
    </button>
  `;
  const btn = li.querySelector('button');
  btn.addEventListener('click', () => {
    addTaskFromItem(item, isQuickWin);
    btn.textContent = 'Added';
    btn.classList.remove('secondary');
    btn.classList.add('ghost');
    btn.disabled = true;
  });
  return li;
}

function addAllTasks() {
  if (!state.scan) return;
  const quickWins = state.scan.items.filter(i => i.quick_win);
  let added = 0;
  quickWins.forEach(item => {
    if (!state.tasks.some(t => t.sourceId === item.id)) {
      addTaskFromItem(item, true);
      added++;
    }
  });
  toast(added ? `Added ${added} quick-win tasks` : 'Already in your list');
  renderScanResults();
}

function addTaskFromItem(item, isQuickWin) {
  const task = {
    id: 't_' + Math.random().toString(36).slice(2, 9),
    sourceId: item.id,
    title: item.title,
    object: item.object || '',
    why: item.why || '',
    minutes: item.minutes || 1,
    priority: item.priority || 'low',
    quickWin: !!isQuickWin,
    assignedTo: null,
    done: false,
    microSteps: null,
    microStepsExpanded: false,
    createdAt: Date.now(),
  };
  state.tasks.push(task);
  autoAssign(task);
  save(LS.tasks, state.tasks);
  renderTasks();
}

// --- Family ---
function addMember() {
  const input = document.getElementById('new-member');
  const name = input.value.trim();
  if (!name) return;
  if (state.family.some(m => m.name.toLowerCase() === name.toLowerCase())) {
    return toast('Already added');
  }
  const member = {
    id: 'm_' + Math.random().toString(36).slice(2, 9),
    name,
    color: PALETTE[state.family.length % PALETTE.length],
  };
  state.family.push(member);
  save(LS.family, state.family);
  input.value = '';
  renderFamily();
  renderTasks();
}

function removeMember(id) {
  state.family = state.family.filter(m => m.id !== id);
  state.tasks.forEach(t => { if (t.assignedTo === id) t.assignedTo = null; });
  save(LS.family, state.family);
  save(LS.tasks, state.tasks);
  renderFamily();
  renderTasks();
}

function renderFamily() {
  const list = document.getElementById('members-list');
  const empty = document.getElementById('members-empty');
  list.innerHTML = '';
  if (!state.family.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  state.family.forEach(m => {
    const taskCount = state.tasks.filter(t => t.assignedTo === m.id && !t.done).length;
    const div = document.createElement('div');
    div.className = 'member-row';
    div.innerHTML = `
      <div class="avatar" style="background:${m.color}">${m.name[0].toUpperCase()}</div>
      <div style="flex:1">
        <div style="font-weight:600">${escapeHtml(m.name)}</div>
        <div style="font-size:12px;color:var(--muted)">${taskCount} open task${taskCount === 1 ? '' : 's'}</div>
      </div>
      <button class="btn small ghost" aria-label="Remove">Remove</button>
    `;
    div.querySelector('button').addEventListener('click', () => removeMember(m.id));
    list.appendChild(div);
  });
}

// --- Fair assignment ---
// Auto-assign new task to person with the lowest current minute-load.
function autoAssign(task) {
  if (!state.family.length) return;
  const loads = state.family.map(m => ({
    id: m.id,
    load: state.tasks
      .filter(t => t.assignedTo === m.id && !t.done && t.id !== task.id)
      .reduce((s, t) => s + (t.minutes || 1), 0),
  }));
  loads.sort((a, b) => a.load - b.load);
  task.assignedTo = loads[0].id;
}

// Reassign every open task fairly from scratch.
function reassignAll() {
  if (!state.family.length) return toast('Add family members first');
  // Sort by minutes desc so we balance high-effort first.
  const open = state.tasks.filter(t => !t.done).sort((a, b) => (b.minutes || 1) - (a.minutes || 1));
  open.forEach(t => t.assignedTo = null);
  open.forEach(t => autoAssign(t));
  save(LS.tasks, state.tasks);
  renderTasks();
  toast('Tasks re-balanced');
}

// --- Tasks view ---
function renderTasks() {
  // Filter pills
  const pills = document.getElementById('task-filter');
  pills.innerHTML = '';
  const tabs = [
    { id: 'all', label: 'All' },
    { id: 'quickwin', label: '⚡ Quick wins' },
    ...state.family.map(m => ({ id: m.id, label: m.name, color: m.color })),
    { id: 'done', label: 'Done' },
  ];
  tabs.forEach(t => {
    const b = document.createElement('button');
    b.textContent = t.label;
    if (state.filter === t.id) b.classList.add('active');
    b.addEventListener('click', () => { state.filter = t.id; renderTasks(); });
    pills.appendChild(b);
  });

  // List
  const list = document.getElementById('tasks-list');
  list.innerHTML = '';
  let tasks = state.tasks.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const p = { high: 0, medium: 1, low: 2 };
    return (p[a.priority] ?? 3) - (p[b.priority] ?? 3);
  });
  if (state.filter === 'quickwin') tasks = tasks.filter(t => t.quickWin && !t.done);
  else if (state.filter === 'done') tasks = tasks.filter(t => t.done);
  else if (state.filter !== 'all') tasks = tasks.filter(t => t.assignedTo === state.filter);

  document.getElementById('tasks-empty').style.display = tasks.length ? 'none' : 'block';
  document.getElementById('reassign-btn').style.display =
    state.family.length && state.tasks.some(t => !t.done) ? 'block' : 'none';

  tasks.forEach(t => list.appendChild(renderTaskRow(t)));
}

function renderTaskRow(t) {
  const li = document.createElement('li');
  li.className = 'task' + (t.done ? ' done' : '');
  const member = state.family.find(m => m.id === t.assignedTo);

  // Build assignment selector
  const assignOptions = ['<option value="">Unassigned</option>',
    ...state.family.map(m => `<option value="${m.id}" ${m.id === t.assignedTo ? 'selected' : ''}>${escapeHtml(m.name)}</option>`)
  ].join('');

  const hasSteps = t.microSteps && t.microSteps.length;
  const breakdownLabel = t._breakingDown
    ? '<span class="spinner"></span> Breaking down…'
    : hasSteps
      ? (t.microStepsExpanded ? 'Hide steps' : `Show ${t.microSteps.length} steps`)
      : '✨ Break it down';

  const stepsHtml = (hasSteps && t.microStepsExpanded) ? `
    <ol class="micro-steps">
      ${t.microSteps.map((s, i) => `
        <li class="micro-step ${s.done ? 'done' : ''}" data-step-id="${s.id}">
          <button class="checkbox small ${s.done ? 'checked' : ''}" aria-label="Toggle step"></button>
          <span class="micro-num">${i + 1}</span>
          <span class="micro-title">${escapeHtml(s.title)}</span>
          <span class="micro-time">${s.seconds}s</span>
        </li>
      `).join('')}
    </ol>
  ` : '';

  li.innerHTML = `
    <button class="checkbox" aria-label="Toggle done"></button>
    <div class="task-body">
      <div class="task-title">${escapeHtml(t.title)}</div>
      ${t.object ? `<div style="font-size:12px;color:var(--accent-2);margin-top:2px">👁 ${escapeHtml(t.object)}</div>` : ''}
      <div class="task-meta" style="margin-top:6px">
        <span class="chip priority-${t.priority}">${t.priority}</span>
        <span class="chip">⏱ ${t.minutes} min</span>
        ${t.quickWin ? '<span class="chip" style="color:var(--accent-2)">quick win</span>' : ''}
        ${member ? `<span class="chip member" style="background:${member.color}22;border-color:${member.color}66;color:${member.color}">👤 ${escapeHtml(member.name)}</span>` : ''}
      </div>
      ${!t.done ? `<button class="breakdown-btn">${breakdownLabel}</button>` : ''}
      ${stepsHtml}
      ${state.family.length ? `
        <select style="margin-top:8px;font-size:12px;padding:6px 10px">${assignOptions}</select>
      ` : ''}
    </div>
    <button class="btn small ghost del-btn" aria-label="Delete">✕</button>
  `;
  // Parent-task checkbox is the FIRST .checkbox (not the step checkboxes inside the body)
  li.children[0].classList.toggle('checked', t.done);
  li.children[0].addEventListener('click', () => toggleDone(t.id));

  const breakBtn = li.querySelector('.breakdown-btn');
  if (breakBtn && !t._breakingDown) {
    breakBtn.addEventListener('click', () => breakdownTask(t.id));
  }

  li.querySelectorAll('.micro-step').forEach(el => {
    const stepId = el.dataset.stepId;
    el.querySelector('.checkbox').addEventListener('click', () => toggleMicroStep(t.id, stepId));
  });

  const select = li.querySelector('select');
  if (select) select.addEventListener('change', e => assignTo(t.id, e.target.value || null));
  li.querySelector('.del-btn').addEventListener('click', () => deleteTask(t.id));
  return li;
}

function toggleDone(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  save(LS.tasks, state.tasks);
  renderTasks();
  renderFamily();
}
function assignTo(id, memberId) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t.assignedTo = memberId;
  save(LS.tasks, state.tasks);
  renderTasks();
  renderFamily();
}
function deleteTask(id) {
  state.tasks = state.tasks.filter(x => x.id !== id);
  save(LS.tasks, state.tasks);
  renderTasks();
  renderFamily();
}

// --- Settings ---
function saveSettings() {
  const key = document.getElementById('api-key-input').value.trim();
  const model = document.getElementById('model-select').value;
  if (key) localStorage.setItem(LS.key, key); else localStorage.removeItem(LS.key);
  localStorage.setItem(LS.model, model);
  updateApiBadge();
  toast('Settings saved');
}

function clearData() {
  if (!confirm('Clear all tasks, family, and the API key on this device?')) return;
  Object.values(LS).forEach(k => localStorage.removeItem(k));
  state.family = []; state.tasks = []; state.scan = null;
  document.getElementById('api-key-input').value = '';
  document.getElementById('scan-results').style.display = 'none';
  updateApiBadge();
  renderFamily();
  renderTasks();
  toast('Cleared');
}

// --- Utils ---
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function formatMinutes(total) {
  if (total < 60) return total + ' min';
  const m = Math.floor(total / 60), s = total % 60;
  return `${m}:${s.toString().padStart(2,'0')}`;
}
