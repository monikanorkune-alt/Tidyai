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
    .then(d => { PLAYBOOK = d; populateStainDatalist(); return d; })
    .catch(err => { console.error('Playbook load failed', err); return null; });
}

// Populate the <datalist> with all 802 stain names for the typed-origin autocomplete.
function populateStainDatalist() {
  const dl = document.getElementById('stain-names-list');
  if (!dl || !PLAYBOOK) return;
  dl.innerHTML = PLAYBOOK.stains.map(s => `<option value="${s.name.replace(/"/g, '&quot;')}"></option>`).join('');
}

// Color per category (22 internal categories in the 802-stain playbook).
// Used for chips, picker buttons, and the result card. Falls back to muted grey.
const CATEGORY_COLORS = {
  food_hot_beverages: '#ffb547', food_soft_drinks: '#ffb547', food_juices: '#ffb547',
  food_alcohol: '#ffb547', food_sauces: '#ffb547', food_dairy_chocolate: '#ffd166',
  food_other: '#ffd166',
  body_fluids: '#ff5d73',
  cosmetics: '#f78bff', hair_body_care: '#f78bff',
  office_art: '#5eb8ff', kids_craft: '#5eb8ff',
  outdoor_nature: '#29d3a3', plant_garden: '#06d6a0',
  pet_stains: '#ffd166',
  automotive: '#95a0b8', industrial: '#95a0b8',
  medical: '#29d3a3',
  household_mystery: '#7c5cff', cleaning_mishaps: '#7c5cff',
  seasonal: '#06d6a0', obscure: '#95a0b8',
};
function catColor(id) { return CATEGORY_COLORS[id] || '#95a0b8'; }
function catLabel(id) {
  const c = PLAYBOOK?.categories.find(x => x.id === id);
  return c?.label || id;
}
// Estimate minutes from a stain's step count + treatment_summary length.
function estimateMinutes(stain) {
  const steps = (stain.steps || []).length;
  const text = (stain.treatment_summary || '').toLowerCase();
  if (text.includes('overnight') || text.includes('hours')) return 30;
  if (text.includes('30 min') || text.includes('1 hour')) return 15;
  if (steps <= 2) return 3;
  if (steps <= 4) return 5;
  return 8;
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
  // Enter on the typed-origin input triggers the search
  const typedInput = document.getElementById('stain-typed-input');
  if (typedInput) {
    typedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findByTypedName(); }
    });
  }
  loadPlaybook();
  // On boot the Laundry view shows just the photo upload card. The question
  // appears after a photo is chosen; the result card after a match is made.
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
  if (name === 'laundry') {
    loadPlaybook();
    renderStainHistory();
    // Photo upload card is always visible. The question only appears after
    // a photo is chosen, and the result/typed cards only after the user picks.
    if (!state.stainScan && !state.stainTreatment) {
      hideAll(['stain-origin-question', 'stain-typed-card', 'stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final']);
    }
  }
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

const STAIN_SYSTEM_PROMPT = `You are TidyAI's stain identification assistant, backed by a curated playbook of 802 specific stain treatments compiled from r/laundry, r/CleaningTips, the KismaiAesthetics spa day community, Tide and OxiClean stain libraries, Clorox how-tos, and lifestyle blog deep-dives.

YOUR JOB
Identify the stain in the photo as precisely as you can, then return STRICT JSON. A separate playbook lookup applies the actual treatment — you NEVER prescribe one yourself, never invent steps, never make up a product name. Identification only.

================================================================
PART 1 — AI VISION IDENTIFICATION GUIDE
Use these four axes together to identify the stain. Combine all four signals before deciding.
================================================================

AXIS 1 — COLOR OF THE STAIN

• Bright yellow / yellow-orange:
   - Likely: sweat + aluminum antiperspirant (set), curry, turmeric, mustard, Mountain Dew, yellow Gatorade, pediatric amoxicillin, fake tan, spray tan, urine (dried), sunscreen-iron reaction, betadine/iodine (orange-brown), baby formula stains, paprika.
• Mustard-yellow halo around a faded older mark:
   - Likely: oxidized sweat, sebum yellowing on collar, sunscreen+iron reaction (avobenzone), set armpit stain.
• Crusty yellow ring on pillowcase / hat band:
   - Likely: drool + sebum + facial product residue, hair gel ring.
• Dusty / aged yellow on stored whites:
   - Likely: cellulose rust, age oxidation, foxing on linens, yellowed pit area.
• Bright red / vivid red wet:
   - Likely: fresh blood, red wine, ketchup, red Gatorade, hot sauce, fruit juice, cherry juice, salsa, pomegranate, red Slurpee.
• Dark red / set red:
   - Likely: dried blood, set red wine, beet juice, pomegranate, dried cherry, cranberry.
• Pink / rose:
   - Likely: faded wine, calamine lotion, fake blood diluted, raspberry, hibiscus tea, semi-permanent hair dye, lipstick.
• Red-orange with oily sheen:
   - Likely: lipstick, BBQ sauce, salsa with oil, sriracha, gochujang, pizza sauce.
• Magenta / fuchsia bright:
   - Likely: hair dye, Mountain Dew Code Red, food coloring spill, beet, Kool-Aid red.
• Light brown / tan wet:
   - Likely: coffee, tea, soy sauce, gravy, broth, latte, hoisin, Worcestershire.
• Dark brown with halo:
   - Likely: set coffee/tea/wine/soda, iron rust ring, set blood, dried iodine.
• Brown crusty:
   - Likely: dried blood, dried chocolate, dried iodine/betadine (very stubborn brown), set BBQ.
• Brown with oily sheen:
   - Likely: gravy, peanut butter, chocolate syrup, bacon grease, nutella, set buttered sauce.
• Reddish-brown rust tone:
   - Likely: iron oxide stain, set blood, dried Worcestershire, foxing.
• Solid black with sheen:
   - Likely: pen ink (ballpoint, Sharpie), mascara, eyeliner, motor oil, stove polish, shoe polish, gel eyeliner.
• Black matte / sooty:
   - Likely: fireplace ash, cigarette smoke residue, brake dust, candle soot, exhaust carbon.
• Black with metallic sheen:
   - Likely: pencil graphite, charcoal, silver nitrate (rare lab), iron transfer.
• Black greasy spread:
   - Likely: bike chain, axle grease, road tar, asphalt sealer.
• Bright blue:
   - Likely: ballpoint pen ink, blue Gatorade, blue ice pop, blue marker, mouthwash, surgical marker, Windex.
• Green sheen:
   - Likely: grass, plant chlorophyll, slime, kid's marker, gochujang, spinach, pesto layer.
• Olive / dark green:
   - Likely: pesto, guacamole oil layer, fresh henna paste, algae, matcha, kale.
• Purple / violet:
   - Likely: berry juices (blueberry, blackberry), grape soda, beet juice, surgical marker, mulberry.
• Clear / colorless oily sheen on dry fabric:
   - Likely: cooking oil, butter, body lotion, sunscreen, body oil, salad dressing, hair oil, beard oil, mineral oil.
• Looks like water but fabric stiff when dry:
   - Likely: hairspray buildup, perfume on silk, super glue residue, fabric paint set, white wine that dried.
• Damp halo with no clear color:
   - Likely: white wine (yellows over time), Sprite, sugary clear drinks, saliva, fresh urine.
• Chalky white on dark fabric:
   - Likely: deodorant marks (fresh), mineral hard water spots, salt tide line, mineral sunscreen residue.
• Pearly white powder:
   - Likely: setting powder, makeup powder, talc/baby powder, cornstarch, baby powder substitute.
• Flaky white residue ring:
   - Likely: detergent buildup, hard water residue, soap scum, fabric softener overdose.

AXIS 2 — TEXTURE AND APPEARANCE

• Glossy / oily sheen → fat- or oil-based stain (cosmetics, food oil, lotion, sunscreen, lipstick, mascara, BBQ sauce, peanut butter, butter). Treatment cue: a surfactant is needed before anything else.
• Crusty / dry / cracked → protein-based and set (dried blood, milk, egg, dairy, sweat, vomit, urine). Treatment cue: cold water only, enzyme detergent; hot water cooks proteins in.
• Sticky / tacky residue → sugar, glue, sap, or polymer (gum, super glue, syrup, slime, jam, tape residue, candle wax warm, semi-dry nail polish). Treatment cue: identify base — sugar dissolves in water, polymer needs solvent, wax needs heat-extraction.
• Powdery / loose → dry pigment (makeup powder, pollen, ash, dry clay, dirt, chalk, paprika, cocoa, baby powder). Treatment cue: brush off DRY first; never rub, never wet.
• Crystalline / sparkly → dried salt or sugar (salt tide on boots, sugar crystallized from jam, kombucha residue). Treatment cue: water dissolves both.
• Fuzzy / coated → organic growth (mold, mildew, lichen, fabric fluff bonded to dye transfer). Treatment cue: vinegar soak + hot wash + sunlight.
• Hardened / brittle → cured polymer or wax (dried glue, cured paint, dried candle wax, dried nail polish, ski wax). Treatment cue: scrape mechanically first, then identify polymer/wax for the right solvent.

AXIS 3 — LOCATION ON GARMENT

• Collar / neckline:
   - Yellow grime ring → sebum + sweat + hair products + sunscreen ("ring around the collar").
   - Red/pink smudge → lipstick or makeup transfer.
   - Brown stripe → hair dye transfer, foundation transfer, fake tan.
• Armpit / under-sleeve:
   - Yellow halo → sweat + aluminum antiperspirant reaction (most common stain on white shirts).
   - White chalk marks → fresh deodorant residue.
   - Stiff fabric → set antiperspirant + body oil.
• Lap / front of thigh → most likely food or drink spill — match color cue.
• Knee / front of shin → grass (green), dirt (brown), blood (kids), road rash residue, motor oil (workwear), paint.
• Bum / lower back → outdoors: grass, dirt, mud, wet bench paint, tree sap. Period accidents on white pants: blood along the seat seam.
• Cuff / wrist → hand contact: ink, marker, food handling smudges, soap residue.
• Hem / floor contact → dirt, mud, salt tide line, oil from auto shop floor, pet drag marks.
• Pocket area → pen ink (forgotten pen in dryer), mechanical pencil lead, lip balm melted, gum melted, candy.

AXIS 4 — FRESHNESS SIGNAL

• Wet dark border around stain → fresh, easiest treatment.
• Halo ring (especially yellow) around stain → was washed but residue oxidized in dryer heat — much harder to remove.
• Crusty edge on colored stain → protein dried (blood, dairy, egg).
• Sticky outside edge → sugar-based (soda, syrup, juice). Wash before it caramelizes.
• Stiff fabric, slight relief texture → paint, glue, or hair product cured — needs solvent.
• Cracked, peeling color → old hair dye, henna, or oxidized blood. Often partial recovery only.

================================================================
PART 2 — CATEGORY STRUCTURE (802 stains across 22 internal categories)
You return ONE name as exactly written in the relevant list. If the stain you see is very close to a listed name but not exact, return the closest match — a fuzzy lookup runs after you. Examples per category (not exhaustive):
================================================================

FOOD & DRINK — HOT BEVERAGES (food_hot_beverages):
Black coffee, Coffee with cream, Latte / cappuccino, Espresso, Iced coffee, Cold brew concentrate, Coffee creamer (powdered, dry), Coffee creamer (liquid, sugary), Black tea, Green tea, Herbal tea (red rooibos, hibiscus), Matcha (green powder + milk), Bubble tea (boba) — milk tea drip, Chai tea (spiced + milk), Hot chocolate, Mocha / chocolate latte, Coffee shop syrup (caramel/vanilla), Pumpkin spice latte, Honey-sweetened tea, Tea bag residue.

FOOD & DRINK — SOFT DRINKS (food_soft_drinks):
Cola (Coke / Pepsi / dark soda), Root beer, Diet cola, Citrus soda (Sprite, 7Up), Mountain Dew (neon yellow), Orange soda (Fanta), Grape soda, Cream soda, Energy drink (Red Bull, Monster), Red Bull (yellow), Energy drink (green/blue artificial), Kombucha, Tonic water (quinine), Ginger ale / ginger beer, Slurpee / slushie (red), Slurpee / slushie (blue), Sno-cone syrup.

FOOD & DRINK — JUICES (food_juices):
Orange juice, Grapefruit juice, Apple juice, Cranberry juice, Pomegranate juice, Grape juice, Cherry juice, Beet juice, Carrot juice, Tomato juice, Pineapple juice, Mango juice / smoothie, Pickle juice, V8 / vegetable juice, Lemon / lime juice, Aloe juice / aloe vera gel, Coconut water, Watermelon juice.

FOOD & DRINK — ALCOHOL (food_alcohol):
Red wine, White wine, Rosé wine, Champagne / sparkling wine, Mulled wine (spiced red), Sangria, Port wine, Beer (light), Beer (dark / stout), Beer foam dried, Bloody Mary, Margarita, Mojito, Piña colada, Cosmopolitan, Espresso martini, Whiskey, Bourbon / rum, Tequila, Vodka, Liqueur (Baileys / cream liqueur), Liqueur (coffee — Kahlúa), Aperol / Campari, Vermouth, Hot toddy.

FOOD & DRINK — SAUCES (food_sauces):
Ketchup, Yellow mustard, Dijon mustard, Whole grain mustard, Mayonnaise, Tomato sauce / marinara, Pasta sauce with meat, Pizza sauce + grease ring, BBQ sauce, Hot sauce (red, vinegar-based), Sriracha, Tabasco, Buffalo sauce, Gochujang, Sambal oelek, Soy sauce, Teriyaki sauce, Hoisin sauce, Fish sauce, Oyster sauce, Worcestershire sauce, Ponzu / yuzu sauce, Pad Thai sauce, Curry (yellow Thai), Curry (red Thai), Curry (green Thai), Curry (Indian butter chicken), Curry (Japanese), Turmeric (powder, dry), Saffron, Paprika, Chili powder / cayenne, Mustard powder, Salsa (red), Salsa verde, Guacamole, Hummus, Pesto, Alfredo sauce, Ranch dressing, Caesar dressing, Italian dressing, Vinaigrette, Thousand Island dressing, Tahini, Peanut sauce / peanut butter, Chimichurri, Tartar sauce, Honey mustard, Honey, Maple syrup, Corn syrup, Molasses, Agave nectar.

FOOD & DRINK — CHOCOLATE / DAIRY / EGGS (food_dairy_chocolate):
Milk chocolate, Dark chocolate, White chocolate, Hot chocolate (drink), Chocolate syrup, Nutella / hazelnut spread, Cocoa powder dry, Mocha drink, Ice cream (vanilla), Ice cream (chocolate), Ice cream (strawberry), Gelato, Sorbet (fruit), Popsicle (red), Popsicle (orange/yellow), Popsicle (blue), Milk, Whole milk (set / sour), Buttermilk, Cream / heavy cream, Yogurt (plain), Yogurt (fruit), Sour cream, Cottage cheese, Cheese melted (mozzarella), Cheese (blue cheese), Cream cheese, Cheese sauce / nacho cheese, Eggnog, Egg yolk, Egg white, Scrambled egg, Hollandaise sauce, Whipped cream / Cool Whip, Butter / margarine, Ghee (clarified butter), Lard / cooking fat, Bacon grease.

FOOD & DRINK — OTHER FOODS (food_other):
Cooking oil (canola/vegetable), Olive oil, Coconut oil, Sesame oil, Avocado / mashed avocado, Avocado oil, Olives (oil + brine), Jam (strawberry), Jam (raspberry / berry), Jam (apricot / peach), Marmalade, Jelly (grape), Caramel, Toffee / butterscotch, Marshmallow, Sticky candy (gummi), Lollipop residue, Chewing gum, Bubble gum (pink), Tomato (raw, fresh), Spaghetti sauce drips, Lasagna drips, Pesto (oily green), Soup (clear broth), Soup (cream-based), Soup (tomato), Miso paste, Pickle juice / vinegar spill, Sauerkraut, Kimchi, Sushi soy + wasabi, Sushi rice (sticky), Onion juice (clear), Garlic oil, Beet (raw), Carrot (cooked), Spinach (cooked), Pomegranate seeds (juice burst), Kiwi, Banana (mashed), Mango (ripe pulp), Peach juice, Pineapple (juice + pulp), Lemon zest / oil, Vanilla extract.

BODY FLUIDS (body_fluids):
Blood (fresh), Blood (dried, 24h+), Blood (set, washed already), Menstrual blood (fresh), Menstrual blood (set on underwear), Nose bleed, Sweat (fresh), Sweat (yellow pit stains), Sweat (collar grime / ring), Sweat (gym clothes funk), Sweat (back / lower back), Body oil yellowing (sebum on collar), Vomit (fresh), Vomit (dried), Bile / acid reflux, Saliva / drool (sleep stain on pillowcase), Drool on baby clothes, Phlegm / mucus, Earwax, Semen, Breast milk (fresh), Breast milk (set yellow), Baby spit-up, Baby formula, Diaper blowout (poop), Wound drainage / pus, Tears + mascara, Skin oil rings on hat band, Foot sweat (shoe interior).

COSMETICS & MAKEUP (cosmetics):
Lipstick (matte), Lipstick (glossy / waxy), Lipstick (liquid lip tint), Lipstick (red on white collar), Lip gloss, Lip balm (Chapstick), Lip liner pencil, Foundation (liquid), Foundation (powder), Foundation (cream/stick), Foundation (full coverage / waterproof), BB cream / CC cream, Tinted moisturizer, Concealer (liquid), Concealer (stick), Blush (powder), Blush (cream), Bronzer (powder), Contour stick, Highlighter cosmetic (cream), Setting spray, Setting powder, Brow gel, Brow pomade, Brow pencil, Brow tint, Mascara (regular), Mascara (waterproof), Mascara (clear), Eyeliner (liquid), Eyeliner (pencil), Eyeliner (gel), Eyeshadow (powder), Eyeshadow (cream), Eyeshadow (glitter), False eyelash glue, Lash extension adhesive (cyanoacrylate), Nail polish (wet), Nail polish (dried), Gel polish (cured), Nail polish remover spill, Acrylic nail dust, Nail glue.

HAIR & BODY CARE (hair_body_care):
Hair dye (fresh, semi-permanent), Hair dye (fresh, permanent), Hair dye (set / dried), Bleach (hair bleach from salon), Henna paste (fresh), Henna (dried), Hair gel (clear), Hair gel (tinted root cover-up), Hair mousse, Hair pomade / hair wax, Hair oil, Hair serum, Leave-in conditioner, Dry shampoo (powder), Dry shampoo (spray, white), Hairspray (set), Hair mask (clay-based), Hair mask (oil-based), Conditioner residue, Shampoo, Dandruff shampoo, Root touch-up spray, Hair color (temporary chalk), Hair color (semi-permanent vegetable dye), Deodorant white marks (fresh), Antiperspirant aluminum yellowing (set), Spray deodorant (set), Body lotion, Body butter, Body oil, Hand cream, Face cream / moisturizer, Sunscreen (fresh, white), Sunscreen (mineral / zinc oxide white residue), Sunscreen (chemical, set yellow on whites), Sunscreen + chlorine yellow (pool), Spray tan (fresh), Spray tan (dried streaks), Self-tanner / tan mousse, Tan drops (face), Perfume (alcohol-based), Cologne, Solid perfume / oil-based perfume, Body spray, Essential oil, Massage oil, Tea tree oil, Aromatherapy oil blend, Wax depilatory (cool), Wax depilatory (warm/strip wax), Sugar wax, Nair / depilatory cream, Threading paste / shaving foam.

OFFICE, INK & ART (office_art):
Ballpoint ink (blue, fresh), Ballpoint ink (black), Ballpoint ink (red), Ballpoint ink (other colors), Ballpoint ink (set, washed already), Gel pen ink, Rollerball ink, Fountain pen ink (water-based), India ink, Calligraphy ink, Permanent marker / Sharpie (black), Permanent marker (other colors), Highlighter (yellow), Highlighter (pink), Highlighter (green/blue), Dry erase marker, Wet erase marker, Chalk marker / liquid chalk, Fabric marker (washable), Fabric marker (permanent), Paint marker (oil-based), Crayon (room temperature), Crayon (melted in dryer onto load), Crayon on wall (washable), Pencil graphite, Mechanical pencil lead, Colored pencil, Charcoal pencil, Oil pastel, Soft pastel powder, Watercolor paint (wet), Watercolor (dried), Acrylic paint (wet), Acrylic paint (dried), Oil paint (artist), Gouache paint, Tempera paint, Finger paint, Latex wall paint (wet), Latex wall paint (dried), Oil-based wall paint, Spray paint (fresh, wet), Spray paint (dried), Fabric paint (set), Glow-in-the-dark paint, Metallic paint, Enamel paint, White school glue (wet), White school glue (dried), Super glue (cyanoacrylate), Hot glue (cooled), Fabric glue, Wood glue, Contact cement, Epoxy (mixed), Rubber cement, Spray adhesive, Double-sided tape adhesive, Duct tape residue, Masking tape residue, Electrical tape residue, Sticker / label adhesive, Glitter glue (wet), Glitter (loose), Slime (commercial), Slime (homemade with borax), Silly Putty / thinking putty, Play-Doh, Polymer clay (Sculpey, fresh), Polymer clay (baked), Modeling clay (oil-based), Pottery clay / ceramic slip, Charcoal (art).

OUTDOOR & NATURE (outdoor_nature):
Grass, Mud (garden soil), Mud (clay-heavy), Wet leaves stain (chlorophyll), Tree sap / pine resin (fresh), Tree sap (old / polymerized), Pine pitch (heavy), Maple sap, Pollen (yellow), Pollen (lily — worst), Pollen (sunflower), Bird droppings, Seagull droppings, Pigeon droppings, Insect splatter, Mosquito splatter (blood), Spider blood, Snail / slug trail, Algae (pond water), Lake water marks, Salt water marks, Frost / morning dew rings, Mossy patch, Lichen (gray-green), Soot / fireplace ash, Bonfire smoke, Cigarette smoke residue, Cigarette tar, Wood smoke, Cooking smoke (kitchen vent), Candle soot, Concrete splash (wet), Concrete dust, Plaster / drywall dust, Tar / asphalt (road), Sand, Beach sand + sunscreen combo.

PLANT & GARDEN (plant_garden):
Cilantro / parsley juice, Basil oil, Mint juice, Spinach (raw), Lettuce juice, Tomato vine / leaf, Walnut leaf juice, Mulberry, Acorn / oak stain, Berry leaf, Fig, Cherry, Wild plum, Crab apple, Citrus peel oil, Avocado pit oil, Mustard plant, Compost / soil, Fertilizer, Manure, Weed killer (Roundup), Pesticide spray.

PET STAINS (pet_stains):
Pet hair embedded, Pet hair on upholstery, Cat drool, Dog drool, Cat spray, Cat urine (fresh), Cat urine (dried), Dog urine (fresh, on carpet), Dog urine (set in carpet), Pet vomit, Pet vomit on carpet, Pet feces, Cat hairball, Rabbit / small mammal urine, Bird droppings (parakeet, parrot), Fish tank water spill (algae), Reptile shed skin oil, Flea treatment (topical, spilled), Pet shampoo residue, Cat litter dust.

AUTOMOTIVE & MECHANICAL (automotive):
Motor oil (fresh), Motor oil (set), Transmission fluid (red), Brake fluid, Power steering fluid, Hydraulic fluid, Bike chain grease, Wheel bearing grease, Axle grease, White lithium grease, Cutting fluid, Machining coolant, WD-40 overspray, Penetrating oil, 3-in-1 oil, Antifreeze, Gasoline (fresh), Diesel fuel, Kerosene, Battery acid, Battery terminal corrosion, Tire mark on white sneakers, Brake dust, Carbon / exhaust soot, Roadside asphalt sealer, Driveway sealer (water-based), Driveway sealer (asphalt-based), Brake cleaner overspray, Carburetor cleaner overspray, Welding flux, Welding slag, Furniture polish (wood), Stove polish (black), Shoe polish (black), Shoe polish (brown), Saddle soap residue, Boot wax / mink oil, Rubber scuff.

MEDICAL & MEDICINAL (medical):
Betadine / iodine (fresh, orange-brown), Betadine (set, brown), Iodine tincture, Mercurochrome, Hydrogen peroxide bubble, Surgical marker, EKG / ECG gel, Ultrasound gel, Calamine lotion (pink), Cough syrup, Pediatric antibiotic (pink amoxicillin), Pill capsule contents, Vapor rub (Vicks), Bandage adhesive residue, Topical hydrocortisone cream, Antibiotic ointment (Neosporin), Petroleum jelly (Vaseline), Bacitracin / triple antibiotic, Liquid bandage spray, Compression wrap residue, Dental fluoride, Toothpaste (white), Toothpaste (with stripes), Mouthwash, Denture cleaner foam, Eye drops, Hemorrhoid cream, Insulin pen leak.

INDUSTRIAL / SHOP / CHEMICAL (industrial):
Paint thinner / mineral spirits, Turpentine, Lacquer thinner, Acetone spill, Rubber cement thinner, Goo Gone residue, Goof Off residue, Silver nitrate, Copper sulfate, Lab dye, Tattoo ink leakage, Surgical ink prep, Conveyor grease, Printer ink (inkjet), Toner powder, Carbon paper, Receipt thermal paper smudge, Embalming fluid, Prosthetic adhesive, Photo developer fluid, Photo fixer, Photo stop bath, Pool chlorine (yellowing), Bromine (spa), Algaecide, Pool dye marker.

HOUSEHOLD / MINERAL / MYSTERY (household_mystery):
Rust / iron oxide, Iron transfer, Iron scorch (yellow-brown), Iron melted polymer, Curling iron scorch, Hot pan ring, Bleach spot, Mildew / mold (light), Mildew (heavy / black spots), Pink mold (Serratia), Hard water spots, Limescale / calcium deposits, Soap scum residue, Yellow age stains on stored whites, Cellulose rust, Yellowed pit area on white t-shirts (set), Ghost stain, Sebum yellowing (collar grime), Foxing on stored linens, Tarnished silver thread, Smoke odor, Cooking grease vapor, Candle wax (paraffin), Candle wax (beeswax), Candle wax (soy), Candle wax (colored), Lip balm, Ski wax, Surfboard wax, Chewing gum, Sticker / label adhesive residue, Tape residue, Sticker price tag glue, Color bleed, Dye transfer, Hair gel ring on collar / hat band, Pillowcase yellowing, Bug spray (DEET) damage.

SEASONAL & SPECIALTY (seasonal):
Easter egg dye, Easter chocolate cream, Halloween fake blood, Halloween face paint, Halloween candle wax, Theatrical fake blood, Theatrical character makeup, Latex prosthetic adhesive, Christmas candle wax, Christmas tree sap, Pine needle pitch, Tinsel residue, Birthday cake icing (buttercream), Birthday cake icing (fondant), Birthday candle wax, Holi powder, Diwali rangoli powder, Festival glitter + sunscreen + mud combo, Body paint (water-based festival), Body paint (oil-based theatrical), Henna (mehndi, fresh), Glow stick fluid, Glitter (chunky body glitter), Glitter (fine, festival fallout), Neon highlighter body spray, Sports drink — red Gatorade, orange Gatorade, yellow Gatorade, blue Gatorade, green / lime Gatorade, Protein shake (chocolate), Protein shake (vanilla), Pre-workout drink, Sports clay, Sports turf, Field chalk, Mouthguard saliva residue, Sweat + grass + dirt combo, Helmet sweat ring, Bicycle / skateboard road rash blood + dirt, Bicycle chain grease, Snow / road salt tide line, Ski wax, Gondola / lift grease, Camping food spill + smoke + dirt combo, Tent canvas mildew, Beach combo (sand + sunscreen + salt water), Sandcastle clay, Pool dye, Fireworks gunpowder residue, Sparkler residue, Smoke bomb (colored), Incense soot, Sage smudge stick ash, Ceremonial powder (color run race), Glow stick on carpet.

KIDS' ART, CRAFT & TOY (kids_craft):
Crayon (washable Crayola), Crayon on couch upholstery, Sidewalk chalk, Liquid chalk marker, Finger paint (washable), Tempera paint (kid), Construction paper bleed, Markers (kid's washable), Markers (kid's, claimed-washable but set), Slime (homemade), Floam beads, Magic Sand, Edible markers, Stamp ink (red), Stamp ink (black), Stamp ink (embossing), Press-on tattoo / temporary tattoo, Body paint sticks (kid), Soap bubbles solution, Bath bomb (colored).

CLEANING PRODUCTS GONE WRONG (cleaning_mishaps):
Chlorine bleach drip on colored fabric, Chlorine bleach drip on white fabric, Color-safe bleach (oxygen) overdose, Ammonia spill, Toilet bowl cleaner (acidic) spill, Drain cleaner (caustic) spill, Oven cleaner spray spillover, Disinfectant spray (Lysol), Multi-surface spray (Windex), Furniture polish (Pledge) spray, Mold remover spray, Hardwood floor cleaner, Carpet stain remover residue, Stain remover overuse, Fabric softener stain, Scent booster overdose, Laundry detergent splash.

ADDITIONAL & OBSCURE (obscure):
Foundation transfer on shirt collar, Yellow underarm shadow on white linen, Silly String, Spray foam (Great Stuff) insulation, Caulk / silicone (uncured), Caulk (cured), Wood stain (oil-based), Wood stain (water-based), Wood varnish / polyurethane, Polyurethane (spray), Latex glove dye, Latex glove powder, Air freshener spray residue, Plug-in air freshener oil leak, Reed diffuser oil spill, Hand sanitizer, Insect bite cream (calamine pink), Bug bite anti-itch gel, Insect repellent (DEET), Picaridin repellent, Permethrin (clothing pretreatment), Sticky lint roller residue, Scotch tape residue, Pressure washer detergent residue, Carpet shampoo residue, Mattress protector film residue, Curtain hem grime, Tablecloth wine + candle wax combo, White towel — pool chlorine + sunscreen yellow combo, Sneaker midsole yellowing, Mesh sneaker dirt, Suede water marks, Leather salt stain, Bookbinding glue, Diamond paint sealant residue, 3D printer filament fragment, Embroidery wash-away stabilizer residue, Iron-on adhesive, Vinyl HTV misapplied, Iron-on patch residue, Sewing machine oil drop, Knitting yarn fluff, Mascara on white pillowcase, Acne medicine bleach (benzoyl peroxide), Retinol cream, AHA/BHA chemical exfoliant, Shaving cream residue, Beard oil, Beard balm, Mustache wax, Hair fiber (Toppik powder build-up), Tooth-whitening strip residue, Pore strip residue, Acne patch residue, Pet flea collar residue, Pet flea spray, Pet odor (set in dog bed), Litter box urine on bath mat, Wet wipe residue, Baby wipe residue, Diaper rash cream (zinc oxide white), Diaper rash cream (set yellow), Baby powder (talc), Cornstarch powder, Massage candle wax, Aromatherapy bath salt dye, Sea salt body scrub, Coffee scrub, Sugar scrub, Bath bomb fizzy residue, Salt scrub residue, Charcoal face mask, Mud mask (clay), Sheet mask residue, Salicylic acid spot treatment, Adhesive bra residue, Spanx / shapewear lubricant, Hosiery glue, Nipple cover residue.

================================================================
PART 3 — RESPONSE SCHEMA
Return STRICT JSON. No markdown, no preamble, no commentary.
================================================================

Shape A — CONFIDENT (≥ 70% likely):
{
  "confident": true,
  "stain_name": "<EXACT name from the lists above (closest match is fine, fuzzy lookup runs after)>",
  "category": "<one of: food_drink | body_fluids | cosmetics | office_craft | outdoor_nature | pet | mechanical | household | seasonal>",
  "internal_category": "<the granular category id from Part 2, e.g. food_alcohol or hair_body_care>",
  "confidence": <0.7-1.0 float>,
  "color_observation": "<one short sentence on the stain's color and visual signature>",
  "texture_observation": "<oily | crusty | sticky | powdery | crystalline | fuzzy | hardened>",
  "location_observation": "<where on the garment, if visible: collar | pit | lap | knee | bum | cuff | hem | pocket | unknown>",
  "freshness": "fresh" | "set" | "unknown",
  "fabric_observation": "<one short sentence on the fabric: cotton, denim, silk, carpet, upholstery, leather, etc.>",
  "warning_if_any": "<one sentence about heat/bleach/fabric risk, or null>"
}

Shape B — NOT SURE:
{
  "confident": false,
  "needs_category": true,
  "reason": "<one warm sentence explaining what's ambiguous — never blame the user or photo>",
  "suggested_categories": ["<2-4 user-facing category ids: food_drink | body_fluids | cosmetics | office_craft | outdoor_nature | pet | mechanical | household | seasonal>"],
  "candidate_stains": ["<3-6 EXACT stain names from Part 2 that could match>"]
}

================================================================
PART 4 — EDGE CASES
================================================================

• Photo shows a stain on something that isn't fabric/upholstery (skin, wood, plastic, painted wall) → Return Shape B with reason like "This looks like a stain on a surface, not fabric. Want me to use the cleaning playbook instead?" and suggested_categories listing the 2-3 most likely anyway.
• Photo is too dark / blurry / out of focus → Return Shape B with reason "I can't see the stain clearly. Try a better-lit photo or pick a category."
• Multiple stains in one photo → Treat the most prominent one as the answer. Set confidence lower (0.5-0.7). User can re-scan if it was the wrong stain.
• Treatment that requires acetone, bleach, or harsh solvent → Always include a warning_if_any like "Acetone destroys acetate, rayon, modacrylic. Test a hidden seam first."

================================================================
PART 5 — TONE RULES (NEVER VIOLATE)
================================================================

• NEVER make assumptions about how the stain got there. Identify the stain, not the story.
• NEVER moralize ("you really shouldn't drink red wine on white silk").
• NEVER reference the activity that caused it ("looks like you spilled wine at dinner").
• NEVER use shame ("be more careful next time").
• NEVER use urgency manipulation ("ACT IMMEDIATELY!! TIME IS RUNNING OUT!"). "Fresh" means fresh; not "urgent."
• NEVER push a brand. Brands appear only via the playbook lookup.

Return JSON only. No prose, no markdown, no preamble.`;

// --- Origin question: shown AFTER photo is loaded ---
// Photo upload card is always visible. Question card appears once a photo
// is chosen. "Yes" reveals the typed input. "Not sure" runs the AI directly.
function showOriginQuestion() {
  hideAll(['stain-typed-card', 'stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final']);
  const q = document.getElementById('stain-origin-question');
  if (q) q.style.display = 'block';
}

function hideOriginQuestion() {
  const q = document.getElementById('stain-origin-question');
  if (q) q.style.display = 'none';
}

function setOriginMode(mode) {
  // mode: 'known' (typed origin) | 'photo' (AI vision on the loaded photo)
  hideOriginQuestion();
  hideAll(['stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final']);
  if (mode === 'known') {
    const typed = document.getElementById('stain-typed-card');
    if (typed) typed.style.display = 'block';
    if (PLAYBOOK) populateStainDatalist(); else loadPlaybook();
    setTimeout(() => document.getElementById('stain-typed-input')?.focus(), 60);
    document.getElementById('stain-typed-hints').innerHTML = '';
  } else if (mode === 'photo') {
    // Run the AI analysis straight away on the already-loaded photo
    analyzeStain();
  }
}

// --- Find by typed name (no AI call) ---
function findByTypedName() {
  const input = document.getElementById('stain-typed-input');
  if (!input) return;
  const text = (input.value || '').trim();
  if (!text) return toast('Type what the stain is first');
  if (!PLAYBOOK) { toast('Playbook still loading…'); return; }
  const treatment = getStainTreatment(text);
  if (treatment) {
    state.stainTreatment = treatment;
    state.stainScan = {
      confident: true, stain_name: treatment.name, category: treatment.category,
      confidence: 1.0, fabric_observation: '', freshness: 'unknown',
    };
    save(LS.lastStainScan, state.stainScan);
    renderStainResult(state.stainScan);
    return;
  }
  // No match — show the 6 closest entries inline as quick picks.
  const wantTokens = stainTokens(text);
  const ranked = (PLAYBOOK.stains || [])
    .map(s => {
      const set = new Set(stainTokens(s.name));
      let shared = 0;
      for (const t of wantTokens) if (set.has(t)) shared++;
      return { s, score: shared };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const hints = document.getElementById('stain-typed-hints');
  if (ranked.length) {
    hints.innerHTML = `
      <div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 6px">Did you mean</div>
      ${ranked.map(r => `
        <div class="candidate-row" data-stain="${escapeHtml(r.s.name)}">
          <span>${escapeHtml(r.s.name)}</span>
          <span style="color:var(--muted);font-size:18px">›</span>
        </div>
      `).join('')}
    `;
    hints.querySelectorAll('.candidate-row').forEach(el => {
      el.addEventListener('click', () => {
        input.value = el.dataset.stain;
        findByTypedName();
      });
    });
  } else {
    hints.innerHTML = `<p style="color:var(--muted);font-size:13px;margin-top:8px">Nothing in the playbook matched. Try a simpler word like "coffee" or "blood", or switch to the photo mode.</p>`;
  }
}

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
    // Photo is loaded — ask the user whether they already know what caused it.
    showOriginQuestion();
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
// Stopwords ignored during token overlap matching
const STAIN_STOPWORDS = new Set([
  'a', 'an', 'the', 'on', 'in', 'of', 'and', 'or', 'with',
  'stain', 'stains', 'mark', 'spot', 'spots', 'residue',
  'fresh', 'set', 'dried', 'old', 'wet', 'food', 'liquid', 'general',
]);

function stainTokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 1 && !STAIN_STOPWORDS.has(t));
}

function findStainInPlaybook(stainName) {
  if (!PLAYBOOK || !stainName) return null;
  const want = stainName.toLowerCase().trim();

  // 1) Exact match
  let hit = PLAYBOOK.stains.find(s => s.name.toLowerCase() === want);
  if (hit) return hit;

  // 2) Substring containment in either direction
  hit = PLAYBOOK.stains.find(s => {
    const n = s.name.toLowerCase();
    return n.includes(want) || want.includes(n);
  });
  if (hit) return hit;

  // 3) Token-overlap score — find the playbook entry that shares the most
  //    meaningful tokens with the AI's candidate. Threshold: at least one
  //    non-stopword token in common AND that token covers >= 50% of the
  //    candidate's tokens. This catches "food grease" -> "Bacon grease",
  //    "wine spill" -> "Red wine", "ink mark" -> "Ballpoint pen ink", etc.
  const wantTokens = stainTokens(stainName);
  if (!wantTokens.length) return null;

  let best = null;
  let bestScore = 0;
  for (const s of PLAYBOOK.stains) {
    const stainToks = stainTokens(s.name);
    if (!stainToks.length) continue;
    const stainSet = new Set(stainToks);
    let shared = 0;
    for (const t of wantTokens) if (stainSet.has(t)) shared++;
    if (shared === 0) continue;
    // Score = shared / total candidate tokens (i.e. how much of what the AI
    // said is reflected in this playbook entry). Tiebreak: shorter name wins
    // (more specific match).
    const score = shared / wantTokens.length;
    if (score > bestScore || (score === bestScore && best && s.name.length < best.name.length)) {
      best = s;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function getStainTreatment(stainName, fabricHint = null) {
  const stain = findStainInPlaybook(stainName);
  if (!stain) return null;
  const fc = stain.fabric_compatibility || {};
  const warnings = [];
  if (fc.full_note) warnings.push({ fabric: 'general', warning: fc.full_note });
  if (fabricHint && Array.isArray(fc.avoid) && fc.avoid.some(f => f.toLowerCase().includes(fabricHint.toLowerCase()))) {
    warnings.unshift({ fabric: fabricHint, warning: `This treatment is risky on ${fabricHint} — test on a hidden seam first.` });
  }
  return { ...stain, applicable_warnings: warnings, estimated_minutes: estimateMinutes(stain) };
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
    // Prefer the observation from the AI; fall back to the playbook's treatment summary.
    document.getElementById('stain-summary').textContent =
      parsed.fabric_observation || treatment.treatment_summary || '';
    const color = catColor(treatment.category);
    const label = catLabel(treatment.category);
    const urgencyLabel = treatment.urgency === 'act_now' ? 'Act now' : 'Has time';
    document.getElementById('stain-tags').innerHTML = `
      <span class="chip" style="color:${color};border-color:${color}66">${escapeHtml(label)}</span>
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
  ` + cats.map(c => {
    const color = catColor(c.id);
    const count = c.stain_count ? `${c.stain_count} stains` : '';
    return `
      <button class="cat-btn" style="border-color:${color}55" data-cat="${c.id}">
        <span style="color:${color}">${escapeHtml(c.label)}</span>
        <span class="cat-blurb">${escapeHtml(count)}</span>
      </button>
    `;
  }).join('');
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
  document.getElementById('stain-needs-reason').textContent = `Pick the closest match in ${cat.label}.`;
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
  if (!treatment) {
    // Last-resort: show the user the 6 closest playbook entries by token overlap.
    const wantTokens = stainTokens(stainName);
    const ranked = (PLAYBOOK?.stains || [])
      .map(s => {
        const toks = stainTokens(s.name);
        const set = new Set(toks);
        let shared = 0;
        for (const t of wantTokens) if (set.has(t)) shared++;
        return { s, score: shared };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(r => r.s.name);
    if (ranked.length) {
      showCategoryPicker(`I couldn't find "${stainName}" exactly. Did you mean one of these?`, null, ranked);
    } else {
      toast("Couldn't find that one — pick a category instead");
    }
    return;
  }
  // Use the playbook's canonical name (in case the AI candidate was a near-match)
  state.stainTreatment = treatment;
  state.stainScan = {
    confident: true, stain_name: treatment.name, category: treatment.category,
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
  // New schema: steps are plain strings. Old schema: { action, seconds }.
  const raw = steps[i];
  const actionText = typeof raw === 'string' ? raw : (raw?.action || '');
  const seconds = typeof raw === 'object' ? (raw?.seconds || 60) : 60;
  document.getElementById('step-counter').textContent = `Step ${i + 1} of ${steps.length}`;
  document.getElementById('step-action').textContent = actionText;
  document.getElementById('step-time').textContent = `⏱ ${seconds} sec`;
  document.getElementById('step-back-btn').disabled = i === 0;
  document.getElementById('step-next-btn').textContent = i === steps.length - 1 ? 'Done — finish ▶' : 'Done — next ▶';

  // Show products on first step only (role can be "primary", "alternative", or a longer description).
  const prodWrap = document.getElementById('step-products-wrap');
  if (i === 0 && t.products && t.products.length) {
    const roleNice = r => {
      if (!r) return '';
      const s = String(r).toLowerCase();
      if (s === 'primary') return 'first choice';
      if (s === 'alternative') return 'alternative';
      return r;
    };
    prodWrap.innerHTML = `
      <div class="step-products">
        <strong>You'll need</strong>
        <ul>${t.products.map(p => `<li>${escapeHtml(p.name)}${p.role ? ` <span style="color:var(--muted)">— ${escapeHtml(roleNice(p.role))}</span>` : ''}</li>`).join('')}</ul>
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
  state.stainScan = null;
  state.stainImageDataUrl = null;
  localStorage.removeItem(LS.lastStainScan);
  hideAll(['stain-origin-question', 'stain-typed-card', 'stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final']);
  const input = document.getElementById('stain-typed-input');
  if (input) input.value = '';
  // Clear photo preview
  const preview = document.getElementById('stain-preview-img');
  if (preview) { preview.src = ''; preview.style.display = 'none'; }
  const placeholder = document.getElementById('stain-upload-placeholder');
  if (placeholder) placeholder.style.display = 'block';
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
