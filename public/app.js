const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  month: new Date().toISOString().slice(0,7),
  categories: [],
  expenses: [],
  budgets: [],
  filters: { categoryId: '', search: '' },
  charts: { category: null, trend: null },
  editingId: null,
  ui: { totalPrev: 0 }
};

// Category theming and emojis
const CATEGORY_THEME = {
  'Food': { hue: 0, emoji: ['🍔','🍟','🍕','🍜','🥗'] },
  'Grocery': { hue: 45, emoji: ['🛒','🥛','🍞','🥚','🧅'] },
  'Medical': { hue: 160, emoji: ['💊','🩹','🩺','🧴'] },
  'Stationary': { hue: 200, emoji: ['✏️','📒','📎','🖊️'] },
  'Travel': { hue: 25, emoji: ['🚗','🛺','🚌','🚎'] },
};

function getCategoryTheme(name) { return CATEGORY_THEME[name] || { hue: 270, emoji: ['💸'] }; }
function getCategoryIcon(name) { const t = getCategoryTheme(name); return t.emoji[0] || '💸'; }

// Theme
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light') root.classList.add('light'); else root.classList.remove('light');
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  const current = localStorage.getItem('theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// API helpers
async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(await res.text());
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json();
  return res.text();
}

async function loadInitial() {
  state.categories = await api('/api/categories');
  await Promise.all([refreshExpenses(), refreshBudgets(), refreshAnalytics()]);
}

async function ensureCategories() {
  try {
    const latest = await api('/api/categories');
    // Update and re-render if changed or empty
    if (!Array.isArray(state.categories) || state.categories.length !== latest.length) {
      state.categories = latest;
      renderFilters();
    } else if (state.categories.length === 0) {
      state.categories = latest;
      renderFilters();
    }
  } catch (_) { /* ignore */ }
}

async function refreshExpenses() {
  const { month, filters } = state;
  const from = `${month}-01`;
  const to = `${month}-31`;
  const qs = new URLSearchParams({ from, to, ...(filters.categoryId ? { categoryId: filters.categoryId } : {}) });
  const data = await api(`/api/expenses?${qs.toString()}`);
  state.expenses = data;
  renderTable();
}

async function refreshBudgets() {
  state.budgets = await api('/api/budgets');
  renderBudgets();
}

async function refreshAnalytics() {
  const data = await api(`/api/analytics/summary?month=${state.month}`);
  renderSummary(data);
  renderCategoryChart(data.byCategory);
  renderTrendChart(data.byDay);
  // Update background gradient to top category hue
  const top = [...data.byCategory].sort((a,b) => b.total - a.total)[0];
  if (top) {
    const theme = getCategoryTheme(top.category_name);
    const h = theme.hue;
    document.body.style.setProperty('--bg-grad', `radial-gradient(1200px 700px at 12% 8%, hsla(${h},80%,55%,.18), transparent 60%), radial-gradient(900px 600px at 88% 16%, hsla(${(h+40)%360},80%,55%,.12), transparent 60%)`);
  }
}

// Renderers
function renderFilters() {
  const monthPicker = $('#monthPicker');
  monthPicker.value = state.month;
  const categoryFilter = $('#categoryFilter');
  categoryFilter.innerHTML = `<option value="">All</option>` + state.categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  // dialog category select
  const sel = $('#expenseDialog select[name="category_id"]');
  sel.innerHTML = state.categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
}

function formatCurrency(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n || 0);
}

function renderSummary(summary) {
  animateTotal(summary.total);
  const top = [...summary.byCategory].sort((a,b) => b.total - a.total)[0];
  $('#topCategory').textContent = top && top.total > 0 ? `${top.category_name} ${formatCurrency(top.total)}` : '—';
  const over = summary.budgetUsage.filter(b => b.limit > 0 && b.spent > b.limit);
  $('#budgetStatus').textContent = over.length ? `${over.length} over budget` : 'All under budget';
}

function animateTotal(nextValue) {
  const el = $('#totalSpent');
  const start = state.ui.totalPrev || 0;
  const end = Number(nextValue) || 0;
  const duration = 500; // ms
  const t0 = performance.now();
  function tick(t) {
    const p = Math.min(1, (t - t0) / duration);
    const cur = start + (end - start) * p;
    el.textContent = formatCurrency(cur);
    if (p < 1) requestAnimationFrame(tick); else state.ui.totalPrev = end;
  }
  requestAnimationFrame(tick);
}

function renderCategoryChart(rows) {
  const ctx = $('#categoryChart');
  const labels = rows.map(r => r.category_name);
  const data = rows.map(r => r.total);
  const colors = rows.map(r => r.category_color);
  if (state.charts.category) state.charts.category.destroy();
  const textColor = getCss('--text') || '#111';
  state.charts.category = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: { plugins: { legend: { position: 'bottom', labels: { color: textColor } } } }
  });
}

function renderTrendChart(rows) {
  const ctx = $('#trendChart');
  const labels = rows.map(r => r.date.slice(-2));
  const data = rows.map(r => r.total);
  if (state.charts.trend) state.charts.trend.destroy();
  const accent = getCss('--accent') || '#7c3aed';
  const textColor = getCss('--text') || '#111';
  const gridColor = 'rgba(17,17,17,.08)';
  state.charts.trend = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label: 'Daily Spend', data, borderColor: accent, backgroundColor: 'rgba(124,58,237,.15)', tension: .3, fill: true }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor } }, x: { ticks: { color: textColor }, grid: { color: gridColor } } } }
  });
}

function renderBudgets() {
  const container = $('#budgets');
  container.innerHTML = '';
  const month = state.month;
  // compute spend per category for the selected month
  const spentByCategory = new Map();
  for (const e of state.expenses) {
    spentByCategory.set(e.category_id, (spentByCategory.get(e.category_id) || 0) + e.amount);
  }
  for (const b of state.budgets) {
    const spent = spentByCategory.get(b.category_id) || 0;
    const pct = b.monthly_limit > 0 ? Math.min(100, Math.round((spent / b.monthly_limit) * 100)) : 0;
    const over = b.monthly_limit > 0 && spent > b.monthly_limit;
    const row = document.createElement('div');
    row.className = 'budget' + (over ? ' over' : '');
    row.innerHTML = `
      <div>${getCategoryIcon(b.category_name)} ${b.category_name}</div>
      <div class="bar"><div class="fill" style="width:${pct}%; background:${over ? 'var(--danger)' : b.category_color}"></div></div>
      <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
        <span title="Spent this month">${formatCurrency(spent)}</span>
        <input type="number" class="budget-input" data-cid="${b.category_id}" min="0" max="5000" step="50" value="${b.monthly_limit}" style="width:90px;background:transparent;border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:8px;" />
        <button class="btn save-budget" data-cid="${b.category_id}">Save</button>
      </div>
    `;
    container.appendChild(row);
  }
  container.querySelectorAll('.save-budget').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cid = Number(e.currentTarget.dataset.cid);
      const input = container.querySelector(`.budget-input[data-cid="${cid}"]`);
      let val = Number(input.value);
      if (Number.isNaN(val)) val = 0;
      val = Math.max(0, Math.min(5000, val));
      await api('/api/budgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category_id: cid, monthly_limit: val }) });
      await refreshBudgets();
      await refreshAnalytics();
    });
  });
}

function renderTable() {
  const tbody = $('#expenseTable tbody');
  const q = (state.filters.search || '').toLowerCase();
  const rows = state.expenses.filter(e => !q || (e.notes || '').toLowerCase().includes(q) || (e.payment_method || '').toLowerCase().includes(q));
  tbody.innerHTML = rows.map(e => `
    <tr data-id="${e.id}">
      <td>${e.date}</td>
      <td><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:99px;background:${e.category_color};display:inline-block"></span>${getCategoryIcon(e.category_name)} ${e.category_name}</span></td>
      <td>${formatCurrency(e.amount)}</td>
      <td>${e.payment_method || ''}</td>
      <td>${e.notes || ''}</td>
      <td class="row-actions">
        <button class="btn" data-action="edit">Edit</button>
        <button class="btn" data-action="delete">Delete</button>
      </td>
    </tr>
  `).join('');
}

// Dialog logic
async function openDialog(expense) {
  const d = $('#expenseDialog');
  await ensureCategories();
  // Force-populate selects right now in case earlier render missed it
  const cats = state.categories || [];
  const dialogSelect = $('#expenseDialog select[name="category_id"]');
  if (dialogSelect) {
    dialogSelect.innerHTML = cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }
  const sidebarFilter = $('#categoryFilter');
  if (sidebarFilter && sidebarFilter.options.length <= 1) {
    sidebarFilter.innerHTML = `<option value="">All</option>` + cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }
  $('#dialogTitle').textContent = expense ? 'Edit Expense' : 'Add Expense';
  const form = $('#expenseForm');
  form.reset();
  state.editingId = expense ? expense.id : null;
  const dateInput = form.querySelector('input[name="date"]');
  const amountInput = form.querySelector('input[name="amount"]');
  const catSelect = form.querySelector('select[name="category_id"]');
  const methodInput = form.querySelector('input[name="payment_method"]');
  const notesInput = form.querySelector('textarea[name="notes"]');
  if (expense) {
    dateInput.value = expense.date;
    amountInput.value = expense.amount;
    catSelect.value = expense.category_id;
    methodInput.value = expense.payment_method || '';
    notesInput.value = expense.notes || '';
  } else {
    dateInput.value = state.month + '-01';
  }
  d.showModal();
}

async function submitDialog(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const fd = new FormData(form);
  const payload = Object.fromEntries(fd.entries());
  payload.amount = Number(payload.amount);
  payload.category_id = Number(payload.category_id);
  if (state.editingId) {
    const updated = await api(`/api/expenses/${state.editingId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    celebrateCategoryById(payload.category_id);
  } else {
    const created = await api('/api/expenses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    celebrateCategoryById(payload.category_id);
  }
  $('#expenseDialog').close();
  await Promise.all([refreshExpenses(), refreshAnalytics()]);
}

function celebrateCategoryById(categoryId) {
  const cat = state.categories.find(c => c.id === Number(categoryId));
  if (cat) burstEmojis(getCategoryTheme(cat.name).emoji);
}

function burstEmojis(emojis) {
  const root = document.querySelector('.main') || document.body;
  const rect = root.getBoundingClientRect();
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('div');
    s.className = 'confetti-emoji';
    s.textContent = emojis[i % emojis.length];
    s.style.left = Math.random() * (rect.width - 40) + 'px';
    s.style.top = (rect.height - 80 + Math.random() * 20) + 'px';
    s.style.animationDelay = (Math.random() * 0.35) + 's';
    s.style.fontSize = (18 + Math.random() * 10) + 'px';
    root.appendChild(s);
    setTimeout(() => s.remove(), 1600);
  }
}

// Import/Export
async function handleImport(file) {
  const text = await file.text();
  await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: text }) });
  await Promise.all([refreshExpenses(), refreshAnalytics()]);
}

function handleExport() {
  window.location.href = '/api/export';
}

// Sockets
function initSockets() {
  const socket = io();
  socket.on('expense:created', async () => { await Promise.all([refreshExpenses(), refreshAnalytics()]); });
  socket.on('expense:updated', async () => { await Promise.all([refreshExpenses(), refreshAnalytics()]); });
  socket.on('expense:deleted', async () => { await Promise.all([refreshExpenses(), refreshAnalytics()]); });
}

// Events
function bindEvents() {
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#monthPicker').addEventListener('change', async (e) => { state.month = e.target.value; await Promise.all([refreshExpenses(), refreshAnalytics()]); });
  $('#categoryFilter').addEventListener('change', async (e) => { state.filters.categoryId = e.target.value; await refreshExpenses(); });
  $('#addExpenseBtn').addEventListener('click', () => openDialog());
  $('#expenseForm').addEventListener('submit', submitDialog);
  $('#dialogCancel').addEventListener('click', () => { $('#expenseDialog').close(); });
  $('#searchInput').addEventListener('input', () => { state.filters.search = $('#searchInput').value; renderTable(); });
  $('#importFile').addEventListener('change', async (e) => { if (e.target.files[0]) await handleImport(e.target.files[0]); e.target.value = ''; });
  $('#exportBtn').addEventListener('click', handleExport);
  $('#expenseTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const tr = e.target.closest('tr');
    const id = Number(tr.dataset.id);
    const action = btn.dataset.action;
    const expense = state.expenses.find(x => x.id === id);
    if (action === 'edit') {
      openDialog(expense);
    } else if (action === 'delete') {
      if (confirm('Delete this expense?')) {
        await api(`/api/expenses/${id}`, { method: 'DELETE' });
        await Promise.all([refreshExpenses(), refreshAnalytics()]);
      }
    }
  });
  // Button ripple microinteraction
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const span = document.createElement('span');
    const size = Math.max(rect.width, rect.height);
    span.style.cssText = `position:absolute;pointer-events:none;inset:auto;left:${e.clientX-rect.left-size/2}px;top:${e.clientY-rect.top-size/2}px;width:${size}px;height:${size}px;border-radius:999px;background:radial-gradient(circle, rgba(255,255,255,.35), rgba(255,255,255,0) 60%);transform:scale(0);animation:ripple .6s ease forwards;`;
    btn.appendChild(span);
    setTimeout(() => span.remove(), 650);
  });
}

// PWA registration (optional; graceful if missing)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Init
(async function init() {
  // Default to the cinematic dark + orange theme unless user chose otherwise
  applyTheme(localStorage.getItem('theme') || 'dark');
  bindEvents();
  await loadInitial();
  renderFilters();
  initSockets();
  // Make highlight card reactive to mouse for a dynamic sheen
  const highlight = document.querySelector('.card.highlight');
  if (highlight) highlight.addEventListener('mousemove', (e) => {
    const r = highlight.getBoundingClientRect();
    highlight.style.setProperty('--mx', ((e.clientX - r.left) / r.width) * 100 + '%');
    highlight.style.setProperty('--my', ((e.clientY - r.top) / r.height) * 100 + '%');
  });
})();

// Ripple keyframes (injected as a style tag to keep single file)
const rippleStyle = document.createElement('style');
rippleStyle.textContent = `@keyframes ripple{to{transform:scale(1);opacity:0}}`;
document.head.appendChild(rippleStyle);

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}


