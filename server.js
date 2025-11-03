import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  listCategories,
  createCategory,
  listExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  analyticsForMonth,
  getBudgets,
  setBudget,
  importCsvRows,
  exportAllExpenses
} from './db.js';
import { resetCategoriesToDefaults } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
// Expose node_modules for vendor scripts like Chart.js (safe for local dev)
app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));

// ---- API ----
app.get('/api/categories', (req, res) => {
  res.json(listCategories());
});

app.post('/api/categories', (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !color) return res.status(400).json({ error: 'name and color are required' });
  try {
    const cat = createCategory({ name, color });
    res.json(cat);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get('/api/expenses', (req, res) => {
  const { from, to, categoryId } = req.query;
  const items = listExpenses({ from, to, categoryId: categoryId ? Number(categoryId) : undefined });
  res.json(items);
});

app.post('/api/expenses', (req, res) => {
  const { date, amount, category_id, notes, payment_method } = req.body || {};
  if (!date || typeof amount !== 'number' || !category_id) {
    return res.status(400).json({ error: 'date, amount, category_id are required' });
  }
  const created = createExpense({ date, amount, category_id, notes, payment_method });
  io.emit('expense:created', created);
  res.json(created);
});

app.put('/api/expenses/:id', (req, res) => {
  const id = Number(req.params.id);
  const { date, amount, category_id, notes, payment_method } = req.body || {};
  if (!id || !date || typeof amount !== 'number' || !category_id) {
    return res.status(400).json({ error: 'id, date, amount, category_id are required' });
  }
  const updated = updateExpense(id, { date, amount, category_id, notes, payment_method });
  io.emit('expense:updated', updated);
  res.json(updated);
});

app.delete('/api/expenses/:id', (req, res) => {
  const id = Number(req.params.id);
  const ok = deleteExpense(id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  io.emit('expense:deleted', { id });
  res.json({ success: true });
});

app.get('/api/analytics/summary', (req, res) => {
  const { month } = req.query; // YYYY-MM
  if (!month) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
  res.json(analyticsForMonth(month));
});

app.get('/api/budgets', (req, res) => {
  res.json(getBudgets());
});

app.post('/api/budgets', (req, res) => {
  const { category_id, monthly_limit } = req.body || {};
  if (!category_id || typeof monthly_limit !== 'number') {
    return res.status(400).json({ error: 'category_id and monthly_limit are required' });
  }
  // enforce 0..5000 INR cap
  const limit = Math.max(0, Math.min(5000, Number(monthly_limit)));
  const b = setBudget(Number(category_id), limit);
  res.json(b);
});

// Admin: reset categories to defaults (idempotent for demo)
app.post('/api/admin/reset-categories', (req, res) => {
  const cats = resetCategoriesToDefaults();
  res.json({ ok: true, categories: cats });
});
// Convenience GET so you can trigger from the browser address bar
app.get('/api/admin/reset-categories', (req, res) => {
  const cats = resetCategoriesToDefaults();
  res.json({ ok: true, categories: cats });
});

// CSV Import: expects { csv: string }
app.post('/api/import', (req, res) => {
  const { csv } = req.body || {};
  if (!csv) return res.status(400).json({ error: 'csv is required' });
  // CSV columns: date,amount,category,notes,payment_method
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const [header, ...rows] = lines;
  const cols = header.split(',').map(s => s.trim().toLowerCase());
  const required = ['date','amount','category'];
  if (!required.every(r => cols.includes(r))) {
    return res.status(400).json({ error: 'CSV must include date,amount,category columns' });
  }
  const categories = listCategories();
  const nameToId = new Map(categories.map(c => [c.name.toLowerCase(), c.id]));
  const parsed = [];
  for (const r of rows) {
    const values = r.split(',');
    const obj = Object.fromEntries(cols.map((c, i) => [c, values[i] != null ? values[i].trim() : '']));
    const catId = nameToId.get((obj.category || '').toLowerCase());
    if (!catId) continue; // skip unknown
    const amount = Number(obj.amount);
    if (!obj.date || Number.isNaN(amount)) continue;
    parsed.push({
      date: obj.date,
      amount,
      category_id: catId,
      notes: obj.notes || null,
      payment_method: obj.payment_method || null
    });
  }
  importCsvRows(parsed);
  res.json({ imported: parsed.length });
});

// CSV Export
app.get('/api/export', (req, res) => {
  const rows = exportAllExpenses();
  const header = 'id,date,amount,notes,payment_method,category';
  const body = rows.map(r => [r.id, r.date, r.amount, escapeCsv(r.notes || ''), escapeCsv(r.payment_method || ''), escapeCsv(r.category)].join(',')).join('\n');
  const output = `${header}\n${body}`;
  res.header('Content-Type', 'text/csv');
  res.attachment('expenses.csv');
  res.send(output);
});

function escapeCsv(s) {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replaceAll('"', '""') + '"';
  }
  return s;
}

// Fallback to SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', () => {
  // Room for future expansions
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Expense Tracker running on http://localhost:${PORT}`);
});


