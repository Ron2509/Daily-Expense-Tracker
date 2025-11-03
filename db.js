import Database from 'better-sqlite3';

const db = new Database('expense_tracker.db');

db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, -- ISO date string YYYY-MM-DD
  amount REAL NOT NULL CHECK(amount >= 0),
  category_id INTEGER NOT NULL,
  notes TEXT,
  payment_method TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL,
  monthly_limit REAL NOT NULL CHECK(monthly_limit >= 0),
  UNIQUE(category_id),
  FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE
);
`);

// Default categories to seed
const DEFAULT_CATEGORIES = [
    { name: 'Food', color: '#F94144' },
    { name: 'Travel', color: '#F3722C' },
    { name: 'Medical', color: '#43AA8B' },
    { name: 'Stationary', color: '#277DA1' },
    { name: 'Grocery', color: '#F9C74F' }
];

function seedBudgetsForCurrentCategories() {
  const insertBudget = db.prepare('INSERT INTO budgets (category_id, monthly_limit) VALUES (?, ?)');
  const cats = db.prepare('SELECT id, name FROM categories').all();
  for (const cat of cats) {
    // Start with 0 so user sets their own budget
    const limit = 0;
    insertBudget.run(cat.id, limit);
  }
}

export function reseedDefaults() {
  const insert = db.prepare('INSERT INTO categories (name, color) VALUES (@name, @color)');
  const tx = db.transaction(() => {
    for (const c of DEFAULT_CATEGORIES) insert.run(c);
    seedBudgetsForCurrentCategories();
  });
  tx();
}

// Seed default categories if empty
const categoryCount = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
if (categoryCount === 0) {
  reseedDefaults();
}


export function resetCategoriesToDefaults() {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM budgets').run();
    db.prepare('DELETE FROM categories').run();
    reseedDefaults();
  });
  tx();
  return listCategories();
}

export function listCategories() {
  return db.prepare('SELECT id, name, color FROM categories ORDER BY name').all();
}

export function createCategory({ name, color }) {
  const stmt = db.prepare('INSERT INTO categories (name, color) VALUES (?, ?)');
  const info = stmt.run(name, color);
  return { id: info.lastInsertRowid, name, color };
}

export function listExpenses({ from, to, categoryId } = {}) {
  const conditions = [];
  const params = {};
  if (from) { conditions.push('date >= @from'); params.from = from; }
  if (to) { conditions.push('date <= @to'); params.to = to; }
  if (categoryId) { conditions.push('category_id = @categoryId'); params.categoryId = categoryId; }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT e.id, e.date, e.amount, e.notes, e.payment_method, e.category_id,
           c.name AS category_name, c.color AS category_color
    FROM expenses e
    JOIN categories c ON c.id = e.category_id
    ${where}
    ORDER BY e.date DESC, e.id DESC
  `;
  return db.prepare(sql).all(params);
}

export function createExpense({ date, amount, category_id, notes, payment_method }) {
  const stmt = db.prepare(`
    INSERT INTO expenses (date, amount, category_id, notes, payment_method, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  const info = stmt.run(date, amount, category_id, notes || null, payment_method || null);
  return getExpenseById(info.lastInsertRowid);
}

export function updateExpense(id, { date, amount, category_id, notes, payment_method }) {
  const stmt = db.prepare(`
    UPDATE expenses
    SET date = ?, amount = ?, category_id = ?, notes = ?, payment_method = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(date, amount, category_id, notes || null, payment_method || null, id);
  return getExpenseById(id);
}

export function deleteExpense(id) {
  const stmt = db.prepare('DELETE FROM expenses WHERE id = ?');
  const info = stmt.run(id);
  return info.changes > 0;
}

export function getExpenseById(id) {
  return db.prepare(`
    SELECT e.id, e.date, e.amount, e.notes, e.payment_method, e.category_id,
           c.name AS category_name, c.color AS category_color
    FROM expenses e
    JOIN categories c ON c.id = e.category_id
    WHERE e.id = ?
  `).get(id);
}

export function getBudgets() {
  return db.prepare(`
    SELECT b.id, b.category_id, b.monthly_limit, c.name as category_name, c.color as category_color
    FROM budgets b
    JOIN categories c ON c.id = b.category_id
    ORDER BY c.name
  `).all();
}

export function setBudget(category_id, monthly_limit) {
  const upsert = db.prepare(`
    INSERT INTO budgets (category_id, monthly_limit)
    VALUES (?, ?)
    ON CONFLICT(category_id) DO UPDATE SET monthly_limit = excluded.monthly_limit
  `);
  upsert.run(category_id, monthly_limit);
  return db.prepare('SELECT * FROM budgets WHERE category_id = ?').get(category_id);
}

export function analyticsForMonth(month) {
  // month: YYYY-MM
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31`;
  const total = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE date >= ? AND date <= ?`).get(monthStart, monthEnd).total;
  const byCategory = db.prepare(`
    SELECT c.id as category_id, c.name as category_name, c.color as category_color, COALESCE(SUM(e.amount),0) as total
    FROM categories c
    LEFT JOIN expenses e ON e.category_id = c.id AND e.date >= ? AND e.date <= ?
    GROUP BY c.id, c.name, c.color
    ORDER BY total DESC
  `).all(monthStart, monthEnd);
  const budgets = getBudgets();
  const budgetUsage = byCategory.map(row => {
    const b = budgets.find(x => x.category_id === row.category_id);
    return {
      category_id: row.category_id,
      category_name: row.category_name,
      category_color: row.category_color,
      spent: row.total,
      limit: b ? b.monthly_limit : 0,
      percent: b && b.monthly_limit > 0 ? Math.min(100, Math.round((row.total / b.monthly_limit) * 100)) : 0
    };
  });
  const byDay = db.prepare(`
    WITH days AS (
      SELECT date(? , '+' || (n) || ' day') as d FROM (
        SELECT 0 as n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL
        SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12 UNION ALL SELECT 13 UNION ALL
        SELECT 14 UNION ALL SELECT 15 UNION ALL SELECT 16 UNION ALL SELECT 17 UNION ALL SELECT 18 UNION ALL SELECT 19 UNION ALL SELECT 20 UNION ALL
        SELECT 21 UNION ALL SELECT 22 UNION ALL SELECT 23 UNION ALL SELECT 24 UNION ALL SELECT 25 UNION ALL SELECT 26 UNION ALL SELECT 27 UNION ALL SELECT 28 UNION ALL SELECT 29 UNION ALL SELECT 30
      )
    )
    SELECT d as date, COALESCE(SUM(e.amount),0) as total
    FROM days
    LEFT JOIN expenses e ON e.date = days.d
    WHERE d >= ? AND d <= ?
    GROUP BY d
    ORDER BY d
  `).all(monthStart, monthStart, monthEnd);
  return { total, byCategory, budgetUsage, byDay };
}

export function importCsvRows(rows) {
  const insert = db.prepare(`
    INSERT INTO expenses (date, amount, category_id, notes, payment_method, created_at, updated_at)
    VALUES (@date, @amount, @category_id, @notes, @payment_method, datetime('now'), datetime('now'))
  `);
  const tx = db.transaction(() => {
    for (const row of rows) {
      insert.run(row);
    }
  });
  tx();
}

export function exportAllExpenses() {
  return db.prepare(`
    SELECT e.id, e.date, e.amount, e.notes, e.payment_method, c.name as category
    FROM expenses e JOIN categories c ON c.id = e.category_id
    ORDER BY e.date ASC, e.id ASC
  `).all();
}

export default db;


