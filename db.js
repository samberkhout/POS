const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');

const DB_PATH = path.join(__dirname, 'pos.db');
const db = new Database(DB_PATH);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
// Prepared statements container (filled after tables are created)
// ============================================================

const s = {};

// ============================================================
// Schema initialization — must be called before any queries
// ============================================================

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      price_qty2 INTEGER DEFAULT NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number INTEGER NOT NULL,
      customer_name TEXT DEFAULT '',
      items TEXT NOT NULL,
      total INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      payment_reference TEXT DEFAULT '',
      origin TEXT NOT NULL,
      status TEXT DEFAULT 'nieuw',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS option_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note',
      max_choices INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS option_group_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_group_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      price_override INTEGER DEFAULT NULL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (option_group_id) REFERENCES option_groups(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS product_option_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      option_group_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (option_group_id) REFERENCES option_groups(id)
    );
  `);

  // Add price_qty2 column if missing (for existing databases)
  try {
    db.exec('ALTER TABLE products ADD COLUMN price_qty2 INTEGER DEFAULT NULL');
  } catch (e) {
    // Column already exists
  }

  // Now prepare all statements
  s.getAllCategories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC');
  s.createCategory = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
  s.updateCategory = db.prepare('UPDATE categories SET name = ?, sort_order = ? WHERE id = ?');
  s.deleteCategory = db.prepare('DELETE FROM categories WHERE id = ?');
  s.countProductsInCategory = db.prepare('SELECT COUNT(*) as count FROM products WHERE category_id = ?');

  s.getAllProducts = db.prepare(`
    SELECT p.*, c.name as category_name FROM products p
    JOIN categories c ON p.category_id = c.id
    WHERE p.active = 1 ORDER BY c.sort_order ASC, p.sort_order ASC, p.id ASC
  `);
  s.getAllProductsAdmin = db.prepare(`
    SELECT p.*, c.name as category_name FROM products p
    JOIN categories c ON p.category_id = c.id
    ORDER BY c.sort_order ASC, p.sort_order ASC, p.id ASC
  `);
  s.getProductById = db.prepare('SELECT * FROM products WHERE id = ?');
  s.createProduct = db.prepare('INSERT INTO products (name, price, category_id, active, sort_order, price_qty2) VALUES (?, ?, ?, ?, ?, ?)');
  s.updateProduct = db.prepare('UPDATE products SET name = ?, price = ?, category_id = ?, active = ?, sort_order = ?, price_qty2 = ? WHERE id = ?');
  s.deleteProduct = db.prepare('DELETE FROM products WHERE id = ?');

  s.getNextOrderNumber = db.prepare("SELECT MAX(order_number) as max_num FROM orders WHERE date(created_at) = date('now', 'localtime')");
  s.createOrder = db.prepare('INSERT INTO orders (order_number, customer_name, items, total, payment_method, payment_reference, origin, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  s.getOrderById = db.prepare('SELECT * FROM orders WHERE id = ?');
  s.updateOrderStatus = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
  s.updateOrderPayment = db.prepare('UPDATE orders SET payment_method = ?, payment_reference = ?, status = ? WHERE id = ?');
  s.getActiveOrders = db.prepare("SELECT * FROM orders WHERE status IN ('nieuw', 'in_bereiding') ORDER BY created_at ASC");
  s.getOrdersByDate = db.prepare("SELECT * FROM orders WHERE date(created_at) = ? ORDER BY created_at DESC");
  s.getDailyTotals = db.prepare(`
    SELECT COUNT(*) as order_count, COALESCE(SUM(total), 0) as total_revenue,
    COALESCE(SUM(CASE WHEN payment_method = 'pin' THEN total ELSE 0 END), 0) as total_pin,
    COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0) as total_cash,
    COALESCE(SUM(CASE WHEN payment_method = 'online' THEN total ELSE 0 END), 0) as total_online
    FROM orders WHERE date(created_at) = ?
  `);

  // Option groups (uitbreidingskeuzesets)
  s.getAllOptionGroups = db.prepare('SELECT * FROM option_groups ORDER BY sort_order ASC, id ASC');
  s.getOptionGroupById = db.prepare('SELECT * FROM option_groups WHERE id = ?');
  s.createOptionGroup = db.prepare('INSERT INTO option_groups (name, type, max_choices, sort_order) VALUES (?, ?, ?, ?)');
  s.updateOptionGroup = db.prepare('UPDATE option_groups SET name = ?, type = ?, max_choices = ?, sort_order = ? WHERE id = ?');
  s.deleteOptionGroup = db.prepare('DELETE FROM option_groups WHERE id = ?');

  // Option group items
  s.getOptionGroupItems = db.prepare(`
    SELECT ogi.*, p.name as product_name, p.price as product_price
    FROM option_group_items ogi
    JOIN products p ON ogi.product_id = p.id
    WHERE ogi.option_group_id = ?
    ORDER BY ogi.sort_order ASC, ogi.id ASC
  `);
  s.addOptionGroupItem = db.prepare('INSERT INTO option_group_items (option_group_id, product_id, price_override, sort_order) VALUES (?, ?, ?, ?)');
  s.removeOptionGroupItem = db.prepare('DELETE FROM option_group_items WHERE id = ?');
  s.clearOptionGroupItems = db.prepare('DELETE FROM option_group_items WHERE option_group_id = ?');

  // Product <-> option group links
  s.getProductOptionGroups = db.prepare(`
    SELECT pog.*, og.name as group_name, og.type, og.max_choices
    FROM product_option_groups pog
    JOIN option_groups og ON pog.option_group_id = og.id
    WHERE pog.product_id = ?
    ORDER BY pog.sort_order ASC, pog.id ASC
  `);
  s.addProductOptionGroup = db.prepare('INSERT INTO product_option_groups (product_id, option_group_id, sort_order) VALUES (?, ?, ?)');
  s.removeProductOptionGroup = db.prepare('DELETE FROM product_option_groups WHERE id = ?');
  s.getProductOptionGroupLink = db.prepare('SELECT * FROM product_option_groups WHERE product_id = ? AND option_group_id = ?');
  s.clearProductOptionGroups = db.prepare('DELETE FROM product_option_groups WHERE product_id = ?');

  s.getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  s.setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  s.getAllSettings = db.prepare('SELECT * FROM settings');

  // Default settings
  const shopName = getSetting('shop_name');
  if (!shopName) {
    setSetting('shop_name', 'Hopbites');
  }

  const adminHash = getSetting('admin_password_hash');
  if (!adminHash) {
    const hash = bcrypt.hashSync('admin', 10);
    setSetting('admin_password_hash', hash);
    setSetting('admin_password_changed', '0');
  }
}

// ============================================================
// Categories
// ============================================================

function getAllCategories() { return s.getAllCategories.all(); }

function createCategory(name, sortOrder = 0) {
  const info = s.createCategory.run(name, sortOrder);
  return { id: info.lastInsertRowid, name, sort_order: sortOrder };
}

function updateCategory(id, { name, sort_order }) {
  s.updateCategory.run(name, sort_order, id);
}

function deleteCategory(id) {
  const { count } = s.countProductsInCategory.get(id);
  if (count > 0) {
    throw new Error(`Categorie bevat nog ${count} product(en). Verwijder of verplaats deze eerst.`);
  }
  s.deleteCategory.run(id);
}

// ============================================================
// Products
// ============================================================

function getAllProducts() { return s.getAllProducts.all(); }
function getAllProductsAdmin() { return s.getAllProductsAdmin.all(); }
function getProductById(id) { return s.getProductById.get(id); }

function createProduct({ name, price, category_id, active = 1, sort_order = 0, price_qty2 = null }) {
  const info = s.createProduct.run(name, price, category_id, active, sort_order, price_qty2);
  return { id: info.lastInsertRowid, name, price, category_id, active, sort_order, price_qty2 };
}

function updateProduct(id, { name, price, category_id, active, sort_order, price_qty2 = null }) {
  s.updateProduct.run(name, price, category_id, active, sort_order, price_qty2, id);
}

function deleteProduct(id) { s.deleteProduct.run(id); }

// ============================================================
// Orders
// ============================================================

function getNextOrderNumber() {
  const row = s.getNextOrderNumber.get();
  return (row.max_num || 0) + 1;
}

function createOrder({ customer_name = '', items, total, payment_method, payment_reference = '', origin, status = 'nieuw' }) {
  const orderNumber = getNextOrderNumber();
  const itemsJson = typeof items === 'string' ? items : JSON.stringify(items);
  const info = s.createOrder.run(orderNumber, customer_name, itemsJson, total, payment_method, payment_reference, origin, status);
  return getOrderById(info.lastInsertRowid);
}

function getOrderById(id) { return s.getOrderById.get(id); }

function updateOrderStatus(id, status) {
  s.updateOrderStatus.run(status, id);
  return getOrderById(id);
}

function updateOrderPayment(id, { payment_method, payment_reference, status = 'nieuw' }) {
  s.updateOrderPayment.run(payment_method, payment_reference, status, id);
  return getOrderById(id);
}

function getActiveOrders() { return s.getActiveOrders.all(); }
function getOrdersByDate(date) { return s.getOrdersByDate.all(date); }
function getDailyTotals(date) { return s.getDailyTotals.get(date); }

// ============================================================
// Option Groups (Uitbreidingskeuzesets)
// ============================================================

function getAllOptionGroups() { return s.getAllOptionGroups.all(); }
function getOptionGroupById(id) { return s.getOptionGroupById.get(id); }

function createOptionGroup({ name, type = 'note', max_choices = 1, sort_order = 0 }) {
  const info = s.createOptionGroup.run(name, type, max_choices, sort_order);
  return { id: info.lastInsertRowid, name, type, max_choices, sort_order };
}

function updateOptionGroup(id, { name, type, max_choices, sort_order }) {
  s.updateOptionGroup.run(name, type, max_choices, sort_order, id);
}

function deleteOptionGroup(id) {
  s.clearOptionGroupItems.run(id);
  db.prepare('DELETE FROM product_option_groups WHERE option_group_id = ?').run(id);
  s.deleteOptionGroup.run(id);
}

function getOptionGroupItems(groupId) { return s.getOptionGroupItems.all(groupId); }

function addOptionGroupItem({ option_group_id, product_id, price_override = null, sort_order = 0 }) {
  const info = s.addOptionGroupItem.run(option_group_id, product_id, price_override, sort_order);
  return { id: info.lastInsertRowid, option_group_id, product_id, price_override, sort_order };
}

function removeOptionGroupItem(id) { s.removeOptionGroupItem.run(id); }

function getProductOptionGroups(productId) { return s.getProductOptionGroups.all(productId); }

function addProductOptionGroup({ product_id, option_group_id, sort_order = 0 }) {
  const existing = s.getProductOptionGroupLink.get(product_id, option_group_id);
  if (existing) return existing;
  const info = s.addProductOptionGroup.run(product_id, option_group_id, sort_order);
  return { id: info.lastInsertRowid, product_id, option_group_id, sort_order };
}

function removeProductOptionGroup(id) { s.removeProductOptionGroup.run(id); }

function getOptionGroupsForProduct(productId) {
  const links = s.getProductOptionGroups.all(productId);
  return links.map(link => {
    const items = s.getOptionGroupItems.all(link.option_group_id);
    return {
      id: link.option_group_id,
      name: link.group_name,
      type: link.type,
      max_choices: link.max_choices,
      items: items.map(i => ({
        id: i.id,
        product_id: i.product_id,
        name: i.product_name,
        price: i.price_override !== null ? i.price_override : i.product_price,
      })),
    };
  });
}

// ============================================================
// Settings
// ============================================================

function getSetting(key) {
  const row = s.getSetting.get(key);
  return row ? row.value : null;
}

function setSetting(key, value) { s.setSetting.run(key, value); }

function getAllSettings() {
  const rows = s.getAllSettings.all();
  const obj = {};
  for (const row of rows) { obj[row.key] = row.value; }
  return obj;
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  db,
  initializeDatabase,
  getAllCategories, createCategory, updateCategory, deleteCategory,
  getAllProducts, getAllProductsAdmin, getProductById, createProduct, updateProduct, deleteProduct,
  getNextOrderNumber, createOrder, getOrderById, updateOrderStatus, updateOrderPayment,
  getActiveOrders, getOrdersByDate, getDailyTotals,
  getAllOptionGroups, getOptionGroupById, createOptionGroup, updateOptionGroup, deleteOptionGroup,
  getOptionGroupItems, addOptionGroupItem, removeOptionGroupItem,
  getProductOptionGroups, addProductOptionGroup, removeProductOptionGroup,
  getOptionGroupsForProduct,
  getSetting, setSetting, getAllSettings,
};
