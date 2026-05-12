// TidyAI — MVP app logic
// Storage keys
const LS = {
  key: 'tidyai_openai_key',
  model: 'tidyai_model',
  family: 'tidyai_family',
  tasks: 'tidyai_tasks',
  lastScan: 'tidyai_last_scan',
  stainHistory: 'tidyai_stain_history',
  lastStainScan: 'tidyai_last_stain_scan',
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
  // Laundry state
  stainImageDataUrl: null,
  stainScan: load(LS.lastStainScan, null),
  stainTreatment: null,       // current treatment record from playbook
  stainStepIndex: 0,
  stainHistory: load(LS.stainHistory, []),
};

// Playbook (loaded lazily)
let PLAYBOOK = null;
function loadPlaybook() {
  if (PLAYBOOK) return Promise.resolve(PLAYBOOK);
  return fetch('laundry_playbook.json')
    .then(r => r.json())
    .then(d => { PLAYBOOK = d; return d; })
    .catch(err => { console.error('Playbook load failed', err); return null; });
}

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

  // Laundry inputs
  const sg = document.getElementById('stain-gallery-input');
  if (sg) sg.addEventListener('change', onStainFileChosen);
  const sc = document.getElementById('stain-camera-input');
  if (sc) sc.addEventListener('change', onStainFileChosen);
  const sa = document.getElementById('stain-after-input');
  if (sa) sa.addEventListener('change', onStainAfterChosen);
  loadPlaybook();
  if (state.stainScan) renderStainResult(state.stainScan);
  renderStainHistory();

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
  if (name === 'laundry') { loadPlaybook(); renderStainHistory(); }
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
  state.stainScan = null; state.stainHistory = []; state.stainTreatment = null;
  document.getElementById('api-key-input').value = '';
  document.getElementById('scan-results').style.display = 'none';
  resetStainFlow();
  updateApiBadge();
  renderFamily();
  renderTasks();
  renderStainHistory();
  toast('Cleared');
}

// =====================================================================
// LAUNDRY HACKS
// =====================================================================

const STAIN_SYSTEM_PROMPT = `You are TidyAI's stain identification assistant. The user took a photo of a stain on fabric or another surface and wants to know what it is so the app can prescribe the right treatment from a curated playbook.

Your ONLY job is to identify the stain. You DO NOT prescribe treatments — a separate playbook lookup handles that. Never invent or describe a treatment in your response.

Use signals from the photo:
- Color of the stain (red, brown, yellow, oily-clear, black)
- Color of the fabric underneath
- Texture (fresh-wet, dried, crusty, oily, powdery)
- Location on the garment (collar, pit, lap, knee hint at the source)
- Surrounding context (food crumbs, smudge marks, blood smear pattern)

You may consider these 137 known stain types across 9 categories:

FOOD & DRINK: Coffee, Tea, Red wine, White wine, Beer, Champagne / sparkling wine, Cola / dark soda, Fruit juice (clear), Berries (blueberry, blackberry), Strawberry / raspberry, Tomato sauce / pasta sauce, Ketchup, Mustard, BBQ sauce, Soy sauce, Curry / turmeric, Chocolate, Ice cream, Milk / formula, Butter, Cooking oil, Salad dressing (oil), Salad dressing (creamy), Mayonnaise, Egg, Jam / preserves, Honey, Maple syrup, Gravy, Hot sauce (oil-based), Vinegar / pickle juice, Tomato seeds / pulp on linen.

BODY FLUIDS: Blood (fresh), Blood (dried / set), Menstrual blood, Sweat / yellow pit stains, Vomit, Pet urine on fabric, Human urine, Feces / fecal smear, Saliva / drool, Semen, Breast milk / baby spit-up, Nasal mucus.

COSMETICS & PERSONAL CARE: Lipstick (matte), Lipstick (glossy), Foundation, Mascara, Eyeliner, Eyeshadow, Nail polish (wet), Nail polish (dried), Hair dye (fresh), Hair dye (set), Henna, Fake tan / spray tan, Sunscreen (fresh), Sunscreen yellow stains (set), Body lotion, Perfume / cologne, Deodorant white marks, Hair gel / pomade, Hair mousse, Liquid hand soap residue.

OFFICE, ART, CRAFT: Ballpoint pen ink, Permanent marker / Sharpie, Highlighter, Pencil graphite, Crayon (room temperature), Crayon (melted in dryer), Watercolor, Acrylic paint (wet), Acrylic paint (dried), Oil paint, Latex wall paint, White school glue, Super glue, Glitter, Slime, Play-Doh, Sticker / adhesive residue, Packing tape glue.

OUTDOOR & NATURE: Grass, Mud, Clay, Tree sap (fresh), Tree sap (old), Pollen, Bird droppings, Plant chlorophyll, Insect splatter, Tar / asphalt, Soot, Smoke odor, Concrete splash / cement.

PET STAINS: Pet hair embedded, Cat / dog drool, Cat spray, Pet vomit, Pet feces, Cat poop on carpet, Dog mud paw prints.

MECHANICAL & SHOP: Motor oil, Bike chain grease, Axle grease, Cooking grease, WD-40 overspray, Shoe polish, Black rubber scuff, Tar (road tar), Diesel / gasoline smell.

HOUSEHOLD & MYSTERY: Rust / iron stain, Iron scorch mark (light), Bleach spot, Mildew / mold spots on fabric, Hard water spots, Yellow age stains on whites, Ghost stain, Brown storage spots, Yellowed pit area, Chlorine pool damage, DEET damage, Sunscreen-iron yellowing, Candle wax, Beeswax, Chewing gum, Lip balm, Window cleaner overspray.

SEASONAL & SPECIALTY: Easter egg dye, Fake blood, Glow stick fluid, Holi powder, Spray tan, Glitter eye makeup, Festival mud-glitter-sunscreen combo, Ski wax, Snow salt / road salt.

Return STRICT JSON in one of two shapes.

Shape A — confident (>= 70% likely):
{
  "confident": true,
  "stain_name": "<EXACT name from the lists above>",
  "category": "<food_drink | body_fluids | cosmetics | office_craft | outdoor_nature | pet | mechanical | household | seasonal>",
  "confidence": 0.85,
  "fabric_observation": "<one short sentence on the fabric you think this is — cotton, denim, silk, carpet, upholstery, etc.>",
  "freshness": "fresh" | "set" | "unknown",
  "warning_if_any": "<one sentence about heat/bleach/fabric risk, or null>"
}

Shape B — not sure:
{
  "confident": false,
  "needs_category": true,
  "reason": "<one warm sentence explaining what's ambiguous — never blame the photo or the user>",
  "suggested_categories": ["<2-4 category ids from the list above>"],
  "candidate_stains": ["<3-6 EXACT stain names from the lists above>"]
}

If the photo shows a stain on something other than fabric or upholstery (e.g. skin, wood, plastic), return Shape B with reason explaining and suggested_categories listing the most likely 2-3 anyway.

NEVER make assumptions about how the stain got there. NEVER moralize. NEVER reference what activity caused it. NEVER use shame or urgency language.

Return JSON only. No markdown, no commentary, no preamble.`;

// --- Stain photo input ---
function onStainFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  toast('Loading photo…');
  const reader = new FileReader();
  reader.onerror = () => toast('Could not read that file');
  reader.onload = () => {
    const dataUrl = reader.result;
    state.stainImageDataUrl = dataUrl;
    const preview = document.getElementById('stain-preview-img');
    preview.onerror = () => { preview.style.display = 'none'; };
    preview.onload = () => { preview.style.display = 'block'; };
    preview.src = dataUrl;
    document.getElementById('stain-upload-placeholder').style.display = 'none';

    // Downscale in background
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
        state.stainImageDataUrl = canvas.toDataURL('image/jpeg', 0.85);
      } catch (err) { console.warn('downscale failed', err); }
    };
    img.onerror = () => console.warn('decode failed, sending original');
    img.src = dataUrl;
    toast('Photo ready — tap Identify stain');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// --- AI call: identifyStain ---
async function analyzeStain(optionalCategory = null) {
  if (!state.stainImageDataUrl) return toast('Add a photo first');
  const key = localStorage.getItem(LS.key);
  if (!key) { switchTab('settings'); return toast('Add your OpenAI API key in Settings'); }
  const model = localStorage.getItem(LS.model) || 'gpt-4o-mini';
  await loadPlaybook();

  const btn = document.getElementById('stain-analyze-btn');
  const label = document.getElementById('stain-analyze-label');
  if (btn && label) { btn.disabled = true; label.innerHTML = '<span class="spinner"></span> Identifying…'; }

  const userText = optionalCategory
    ? `The user confirmed this stain falls in the category: ${optionalCategory}. Narrow within that category and return either Shape A (a confident pick) or Shape B with up to 5 candidate_stains from that category.`
    : "Identify this stain. If you're not confident, ask for a category.";

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: STAIN_SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: state.stainImageDataUrl, detail: 'low' } },
          ]},
        ],
        max_tokens: 500,
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('OpenAI error: ' + res.status + ' — ' + errText.slice(0, 200));
    }
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    state.stainScan = parsed;
    save(LS.lastStainScan, parsed);
    renderStainResult(parsed);
  } catch (err) {
    console.error(err);
    toast(err.message.length < 80 ? err.message : 'Identification failed — see console');
  } finally {
    if (btn && label) { btn.disabled = false; label.textContent = 'Identify stain'; }
  }
}

// --- Pure playbook lookup ---
function findStainInPlaybook(stainName) {
  if (!PLAYBOOK || !stainName) return null;
  const want = stainName.toLowerCase().trim();
  // Exact match first
  let hit = PLAYBOOK.stains.find(s => s.name.toLowerCase() === want);
  if (hit) return hit;
  // Substring match (handle "Red wine" vs "Red wine — fresh")
  hit = PLAYBOOK.stains.find(s => s.name.toLowerCase().includes(want) || want.includes(s.name.toLowerCase()));
  return hit || null;
}

function getStainTreatment(stainName, fabricHint = null) {
  const stain = findStainInPlaybook(stainName);
  if (!stain) return null;
  const warnings = (stain.fabric_warnings || []).filter(w => !fabricHint || w.fabric === fabricHint || w.fabric === 'any');
  return { ...stain, applicable_warnings: warnings };
}

// --- Render: AI result (confident or category fallback) ---
function renderStainResult(parsed) {
  hideAll(['stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final']);

  if (parsed && parsed.confident && parsed.stain_name) {
    const treatment = getStainTreatment(parsed.stain_name);
    if (!treatment) {
      // AI confident but playbook missed — fall through to category picker
      showCategoryPicker(`I matched it to "${parsed.stain_name}" but don't have a treatment on file. Pick the closest category.`);
      return;
    }
    state.stainTreatment = treatment;
    document.getElementById('stain-confident').style.display = 'block';
    document.getElementById('stain-name').textContent = treatment.name;
    document.getElementById('stain-summary').textContent = parsed.fabric_observation || '';
    const cat = PLAYBOOK?.categories.find(c => c.id === treatment.category);
    const urgencyLabel = treatment.urgency === 'act_now' ? 'Act now' : 'Has time';
    document.getElementById('stain-tags').innerHTML = `
      ${cat ? `<span class="chip" style="color:${cat.color};border-color:${cat.color}66">${escapeHtml(cat.name)}</span>` : ''}
      <span class="chip urgency-${treatment.urgency}">${urgencyLabel}</span>
      <span class="chip">⏱ ~${treatment.estimated_minutes} min</span>
      ${parsed.freshness ? `<span class="chip">${escapeHtml(parsed.freshness)}</span>` : ''}
    `;
    const warningsEl = document.getElementById('stain-warnings');
    const allWarnings = [
      ...(parsed.warning_if_any ? [{ fabric: 'general', warning: parsed.warning_if_any }] : []),
      ...(treatment.applicable_warnings || []),
    ];
    warningsEl.innerHTML = allWarnings.map(w => `
      <div class="fabric-warning"><strong>⚠ Heads up</strong><br>${escapeHtml(w.warning)}</div>
    `).join('');
  } else if (parsed && parsed.needs_category) {
    showCategoryPicker(parsed.reason, parsed.suggested_categories, parsed.candidate_stains);
  }
}

function showCategoryPicker(reason, suggestedCats = null, candidateStains = null) {
  hideAll(['stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final']);
  document.getElementById('stain-needs-category').style.display = 'block';
  document.getElementById('stain-needs-reason').textContent =
    reason || "I want to make sure I get this right. Pick the closest category and I'll narrow it down.";

  // Candidates first (faster path)
  const candEl = document.getElementById('stain-candidates');
  if (candidateStains && candidateStains.length && PLAYBOOK) {
    candEl.innerHTML = '<div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 6px">Looks like one of these?</div>' +
      candidateStains.map(name => `
        <div class="candidate-row" data-stain="${escapeHtml(name)}">
          <span>${escapeHtml(name)}</span>
          <span style="color:var(--muted);font-size:18px">›</span>
        </div>
      `).join('');
    candEl.querySelectorAll('.candidate-row').forEach(el => {
      el.addEventListener('click', () => pickCandidate(el.dataset.stain));
    });
  } else {
    candEl.innerHTML = '';
  }

  // Category grid
  const grid = document.getElementById('stain-category-grid');
  if (!PLAYBOOK) { grid.innerHTML = '<p>Loading categories…</p>'; return; }
  const cats = suggestedCats && suggestedCats.length
    ? PLAYBOOK.categories.filter(c => suggestedCats.includes(c.id))
    : PLAYBOOK.categories;
  grid.innerHTML = `
    <div style="grid-column:1/-1;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-top:8px">Or pick a category</div>
  ` + cats.map(c => `
    <button class="cat-btn" style="border-color:${c.color}55" data-cat="${c.id}">
      <span style="color:${c.color}">${escapeHtml(c.name)}</span>
      <span class="cat-blurb">${escapeHtml(c.blurb || '')}</span>
    </button>
  `).join('');
  grid.querySelectorAll('.cat-btn').forEach(el => {
    el.addEventListener('click', () => pickCategory(el.dataset.cat));
  });
}

function pickCategory(catId) {
  if (!PLAYBOOK) return;
  const cat = PLAYBOOK.categories.find(c => c.id === catId);
  if (!cat) return;
  // Show all stains in that category as candidate list
  const stainsInCat = PLAYBOOK.stains.filter(s => s.category === catId);
  hideAll(['stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final']);
  document.getElementById('stain-needs-category').style.display = 'block';
  document.getElementById('stain-needs-reason').textContent = `Pick the closest match in ${cat.name}.`;
  document.getElementById('stain-candidates').innerHTML =
    stainsInCat.map(s => `
      <div class="candidate-row" data-stain="${escapeHtml(s.name)}">
        <span>${escapeHtml(s.name)}</span>
        <span style="color:var(--muted);font-size:18px">›</span>
      </div>
    `).join('');
  document.getElementById('stain-candidates').querySelectorAll('.candidate-row').forEach(el => {
    el.addEventListener('click', () => pickCandidate(el.dataset.stain));
  });
  document.getElementById('stain-category-grid').innerHTML = '';
}

function pickCandidate(stainName) {
  const treatment = getStainTreatment(stainName);
  if (!treatment) return toast('Couldn\'t find that one — try another');
  state.stainTreatment = treatment;
  state.stainScan = {
    confident: true, stain_name: stainName, category: treatment.category,
    confidence: 1.0, fabric_observation: '', freshness: 'unknown',
  };
  save(LS.lastStainScan, state.stainScan);
  renderStainResult(state.stainScan);
}

// --- Treatment step flow ---
function startTreatment() {
  if (!state.stainTreatment) return toast('Identify the stain first');
  state.stainStepIndex = 0;
  hideAll(['stain-confident', 'stain-needs-category', 'stain-final']);
  document.getElementById('stain-treatment').style.display = 'block';
  renderStep();
}

function renderStep() {
  const t = state.stainTreatment;
  if (!t) return;
  const steps = t.steps || [];
  const i = state.stainStepIndex;
  if (i >= steps.length) return finishTreatment();
  const step = steps[i];
  document.getElementById('step-counter').textContent = `Step ${i + 1} of ${steps.length}`;
  document.getElementById('step-action').textContent = step.action;
  document.getElementById('step-time').textContent = `⏱ ${step.seconds || 60} sec`;
  document.getElementById('step-back-btn').disabled = i === 0;
  document.getElementById('step-next-btn').textContent = i === steps.length - 1 ? 'Done — finish ▶' : 'Done — next ▶';

  // Show products on first step only
  const prodWrap = document.getElementById('step-products-wrap');
  if (i === 0 && t.products && t.products.length) {
    prodWrap.innerHTML = `
      <div class="step-products">
        <strong>You'll need</strong>
        <ul>${t.products.map(p => `<li>${escapeHtml(p.name)} <span style="color:var(--muted)">— ${escapeHtml(p.role || '')}</span></li>`).join('')}</ul>
      </div>
    `;
  } else {
    prodWrap.innerHTML = '';
  }
}

function nextStep() {
  if (!state.stainTreatment) return;
  state.stainStepIndex++;
  if (state.stainStepIndex >= state.stainTreatment.steps.length) finishTreatment();
  else renderStep();
}
function prevStep() {
  if (state.stainStepIndex > 0) { state.stainStepIndex--; renderStep(); }
}

function finishTreatment() {
  const t = state.stainTreatment;
  // Save to history
  if (t) {
    state.stainHistory.unshift({
      id: 'sh_' + Math.random().toString(36).slice(2, 9),
      stainName: t.name,
      category: t.category,
      finishedAt: Date.now(),
    });
    state.stainHistory = state.stainHistory.slice(0, 20);
    save(LS.stainHistory, state.stainHistory);
  }
  hideAll(['stain-confident', 'stain-needs-category', 'stain-treatment']);
  document.getElementById('stain-final').style.display = 'block';
  document.getElementById('stain-verify-result').style.display = 'none';
  document.getElementById('stain-verify-result').innerHTML = '';
  renderStainHistory();
}

// --- After photo + verification ---
function onStainAfterChosen(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    verifyStainRemoved(state.stainImageDataUrl, dataUrl, state.stainTreatment?.name || 'the stain');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

async function verifyStainRemoved(beforeUrl, afterUrl, stainName) {
  const key = localStorage.getItem(LS.key);
  if (!key) return toast('Add your OpenAI API key first');
  const model = localStorage.getItem(LS.model) || 'gpt-4o-mini';
  const wrap = document.getElementById('stain-verify-result');
  wrap.style.display = 'block';
  wrap.innerHTML = '<div style="text-align:center;padding:14px"><span class="spinner"></span> Comparing photos…</div>';

  const sys = `You compare two photos of the same fabric. The user attempted to remove a "${stainName}" stain. Return STRICT JSON:
{
  "removed": true | false,
  "residue_visible": true | false,
  "recommendation": "<one warm, encouraging sentence. If residue is visible, suggest a gentle next pass — never imply failure. If gone, celebrate briefly without gushing. Never compare to ideal homes.>"
}
Output JSON only.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: [
            { type: 'text', text: 'Before photo first, then after photo. Did the treatment work?' },
            { type: 'image_url', image_url: { url: beforeUrl, detail: 'low' } },
            { type: 'image_url', image_url: { url: afterUrl, detail: 'low' } },
          ]},
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });
    if (!res.ok) throw new Error('OpenAI error ' + res.status);
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    const icon = parsed.removed ? '✨' : '🔁';
    wrap.innerHTML = `
      <div style="text-align:center;font-size:28px">${icon}</div>
      <p style="text-align:center;margin-top:6px">${escapeHtml(parsed.recommendation || 'Take a look — you know best.')}</p>
      ${!parsed.removed ? `<button class="btn" onclick="startTreatment()" style="margin-top:8px">Run another pass</button>` : ''}
    `;
  } catch (err) {
    console.error(err);
    wrap.innerHTML = `<p style="color:var(--muted);text-align:center">Couldn't compare automatically. Trust your eyes.</p>`;
  }
}

// --- History list ---
function renderStainHistory() {
  const wrap = document.getElementById('stain-history-wrap');
  if (!wrap) return;
  if (!state.stainHistory.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `
    <h2 style="font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px">Recent</h2>
    ${state.stainHistory.slice(0, 5).map(h => {
      const days = Math.max(0, Math.round((Date.now() - h.finishedAt) / (1000 * 60 * 60 * 24)));
      const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
      return `<div class="member-row"><div style="flex:1">${escapeHtml(h.stainName)}</div><div style="font-size:11px;color:var(--muted)">${when}</div></div>`;
    }).join('')}
  `;
}

function resetStainFlow() {
  state.stainTreatment = null;
  state.stainStepIndex = 0;
  hideAll(['stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final']);
}

function hideAll(ids) {
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
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
