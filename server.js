require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');

const db = require('./db');
const printer = require('./printer');
const adyenTerminal = require('./adyen-terminal');
const adyenCheckout = require('./adyen-checkout');

// ============================================================
// Initialize
// ============================================================

db.initializeDatabase();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.set('trust proxy', true);
app.use(express.json());

// ============================================================
// IP-based access control
// ============================================================

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
}

function isLocalNetwork(reqIp) {
  let ip = reqIp || '';

  // Normalize IPv6-mapped IPv4
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  // Always allow loopback
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;

  // Check against configured CIDR
  const cidr = process.env.LOCAL_NETWORK_CIDR;
  if (cidr && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const [range, bits] = cidr.split('/');
    const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
  }

  // Also allow common private ranges as fallback
  if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(ip)) return true;

  return false;
}

function localOnly(req, res, next) {
  if (!isLocalNetwork(req.ip)) {
    return res.status(403).send('Toegang geweigerd');
  }
  next();
}

// Route protection middleware BEFORE static files
app.use((req, res, next) => {
  const protectedPages = ['/cashier.html', '/kitchen.html', '/admin.html'];
  if (protectedPages.includes(req.path) && !isLocalNetwork(req.ip)) {
    return res.status(403).send('Toegang geweigerd');
  }
  next();
});

// ============================================================
// Convenience redirects
// ============================================================

app.get('/cashier', (req, res) => res.redirect('/cashier.html'));
app.get('/kitchen', (req, res) => res.redirect('/kitchen.html'));
app.get('/admin', (req, res) => res.redirect('/admin.html'));
app.get('/bestel', (req, res) => res.redirect('/bestel.html'));
app.get('/bedankt', (req, res) => res.redirect('/bedankt.html'));

// ============================================================
// Static files
// ============================================================

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Admin authentication
// ============================================================

const adminTokens = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet ingelogd' });
  }
  const token = authHeader.substring(7);
  const session = adminTokens.get(token);
  if (!session || session.expires < Date.now()) {
    adminTokens.delete(token);
    return res.status(401).json({ error: 'Sessie verlopen' });
  }
  next();
}

// ============================================================
// Helper: calculate order total including extensions
// ============================================================

function calculateOrderTotal(items) {
  let total = 0;
  for (const item of items) {
    // Apply price_qty2 if quantity >= 2 and price_qty2 exists
    if (item.price_qty2 && item.quantity >= 2) {
      const packs = Math.floor(item.quantity / 2);
      const singles = item.quantity % 2;
      total += packs * item.price_qty2 + singles * item.price;
    } else {
      total += item.price * item.quantity;
    }
    // Add extension prices (type=item extensions add their price)
    if (item.extensions) {
      for (const ext of item.extensions) {
        if (ext.type === 'item') {
          for (const choice of (ext.items || [])) {
            total += (choice.price || 0) * item.quantity;
          }
        }
      }
    }
  }
  return total;
}

// ============================================================
// PUBLIC API Routes (accessible via Cloudflare Tunnel)
// ============================================================

// Get active menu (products grouped by category)
app.get('/api/menu', (req, res) => {
  try {
    const products = db.getAllProducts();
    const categories = db.getAllCategories();
    const shopName = db.getSetting('shop_name') || 'POS';

    const grouped = categories
      .filter(cat => products.some(p => p.category_id === cat.id))
      .map(cat => ({
        id: cat.id,
        name: cat.name,
        products: products
          .filter(p => p.category_id === cat.id)
          .map(p => ({
            id: p.id,
            name: p.name,
            price: p.price,
            price_qty2: p.price_qty2 || null,
            option_groups: db.getOptionGroupsForProduct(p.id),
          })),
      }));

    res.json({ shopName, categories: grouped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create order from QR customer + initiate Adyen checkout session
app.post('/api/orders/create-qr', async (req, res) => {
  try {
    const { items, customer_name } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ error: 'Geen items in bestelling' });
    }

    const total = calculateOrderTotal(items);
    const order = db.createOrder({
      customer_name: customer_name || '',
      items,
      total,
      payment_method: 'online',
      payment_reference: '',
      origin: 'qr',
      status: 'wacht_op_betaling',
    });

    const orderReference = `QR-${order.id}-${Date.now()}`;
    const session = await adyenCheckout.createCheckoutSession(total, orderReference, order.id);

    res.json({
      orderId: order.id,
      sessionId: session.sessionId,
      sessionData: session.sessionData,
      clientKey: adyenCheckout.getClientKey(),
      environment: adyenCheckout.getEnvironment(),
    });
  } catch (err) {
    console.error('Fout bij aanmaken QR bestelling:', err.message);
    res.status(500).json({ error: 'Kan bestelling niet aanmaken' });
  }
});

// Check order status (for bedankt page polling)
app.get('/api/orders/:id/status', (req, res) => {
  try {
    const order = db.getOrderById(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Bestelling niet gevonden' });
    res.json({
      id: order.id,
      order_number: order.order_number,
      status: order.status,
      customer_name: order.customer_name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Adyen webhook for payment confirmation
app.post('/adyen/webhook', (req, res) => {
  // Must respond immediately with [accepted]
  res.send('[accepted]');

  try {
    const items = req.body.notificationItems || [];
    for (const item of items) {
      const notification = item.NotificationRequestItem;

      if (!adyenCheckout.verifyWebhookHmac(notification)) {
        console.error('HMAC verificatie mislukt voor webhook');
        continue;
      }

      if (notification.eventCode === 'AUTHORISATION' && notification.success === 'true') {
        // Extract orderId from merchantReference (format: QR-{orderId}-{timestamp})
        const refParts = (notification.merchantReference || '').split('-');
        const orderId = parseInt(refParts[1]);

        if (orderId) {
          const order = db.updateOrderPayment(orderId, {
            payment_method: 'online',
            payment_reference: notification.pspReference || '',
            status: 'nieuw',
          });

          if (order) {
            const shopName = db.getSetting('shop_name') || 'POS';
            io.to('kitchen').emit('new-order', order);
            io.to('cashier').emit('qr-order-received', order);
            printer.printReceipt(order, shopName);
            printer.printKitchenTicket(order, shopName);
          }
        }
      }
    }
  } catch (err) {
    console.error('Fout bij verwerken webhook:', err.message);
  }
});

// Confirm QR order payment (called from bedankt.html after iDEAL redirect)
app.post('/api/orders/:id/confirm-payment', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { sessionId } = req.body;
    const order = db.getOrderById(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Bestelling niet gevonden' });
    }

    // Already confirmed (e.g. by webhook) — nothing to do
    if (order.status !== 'wacht_op_betaling') {
      return res.json({ ok: true, already_confirmed: true });
    }

    // Best-effort: verify payment with Adyen if possible
    if (sessionId) {
      try {
        const session = await adyenCheckout.getSessionResult(sessionId);
        if (session.status !== 'completed') {
          console.warn(`Adyen sessie ${sessionId} status: ${session.status} (niet completed)`);
        }
      } catch (verifyErr) {
        console.warn('Adyen sessie verificatie mislukt, bestelling wordt toch bevestigd:', verifyErr.message);
      }
    }

    const updated = db.updateOrderPayment(orderId, {
      payment_method: 'online',
      payment_reference: order.payment_reference || '',
      status: 'nieuw',
    });

    if (updated) {
      const shopName = db.getSetting('shop_name') || 'POS';
      io.to('kitchen').emit('new-order', updated);
      io.to('cashier').emit('qr-order-received', updated);
      printer.printReceipt(updated, shopName);
      printer.printKitchenTicket(updated, shopName);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Fout bij bevestigen QR betaling:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LOCAL-ONLY API Routes
// ============================================================

// --- Admin Login ---

app.post('/api/admin/login', localOnly, async (req, res) => {
  try {
    const { password } = req.body;
    const hash = db.getSetting('admin_password_hash');
    const match = await bcrypt.compare(password, hash);

    if (!match) {
      return res.status(401).json({ error: 'Onjuist wachtwoord' });
    }

    const token = generateToken();
    adminTokens.set(token, { expires: Date.now() + 8 * 60 * 60 * 1000 });

    const passwordChanged = db.getSetting('admin_password_changed') === '1';
    res.json({ token, passwordChanged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/password', localOnly, adminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Wachtwoord moet minimaal 4 tekens zijn' });
    }

    const hash = db.getSetting('admin_password_hash');
    const match = await bcrypt.compare(currentPassword, hash);
    if (!match) {
      return res.status(401).json({ error: 'Huidig wachtwoord is onjuist' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    db.setSetting('admin_password_hash', newHash);
    db.setSetting('admin_password_changed', '1');

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Products ---

app.get('/api/admin/products', localOnly, adminAuth, (req, res) => {
  try {
    res.json(db.getAllProductsAdmin());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/products', localOnly, adminAuth, (req, res) => {
  try {
    const { name, price, category_id, active, sort_order, price_qty2 } = req.body;
    if (!name || price === undefined || !category_id) {
      return res.status(400).json({ error: 'Naam, prijs en categorie zijn verplicht' });
    }
    const product = db.createProduct({
      name,
      price: parseInt(price),
      category_id: parseInt(category_id),
      active: active !== undefined ? (active ? 1 : 0) : 1,
      sort_order: parseInt(sort_order) || 0,
      price_qty2: price_qty2 ? parseInt(price_qty2) : null,
    });
    io.emit('products-updated');
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/products/:id', localOnly, adminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, price, category_id, active, sort_order, price_qty2 } = req.body;
    db.updateProduct(id, {
      name,
      price: parseInt(price),
      category_id: parseInt(category_id),
      active: active ? 1 : 0,
      sort_order: parseInt(sort_order) || 0,
      price_qty2: price_qty2 ? parseInt(price_qty2) : null,
    });
    io.emit('products-updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/products/:id', localOnly, adminAuth, (req, res) => {
  try {
    db.deleteProduct(parseInt(req.params.id));
    io.emit('products-updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Categories ---

app.get('/api/admin/categories', localOnly, adminAuth, (req, res) => {
  try {
    res.json(db.getAllCategories());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/categories', localOnly, adminAuth, (req, res) => {
  try {
    const { name, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: 'Naam is verplicht' });
    const category = db.createCategory(name, parseInt(sort_order) || 0);
    io.emit('products-updated');
    res.json(category);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/categories/:id', localOnly, adminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, sort_order } = req.body;
    db.updateCategory(id, { name, sort_order: parseInt(sort_order) || 0 });
    io.emit('products-updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/categories/:id', localOnly, adminAuth, (req, res) => {
  try {
    db.deleteCategory(parseInt(req.params.id));
    io.emit('products-updated');
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Orders ---

app.post('/api/orders', localOnly, (req, res) => {
  try {
    const { items, customer_name, payment_method } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ error: 'Geen items in bestelling' });
    }

    const total = calculateOrderTotal(items);
    const order = db.createOrder({
      customer_name: customer_name || '',
      items,
      total,
      payment_method: payment_method || 'cash',
      origin: 'cashier',
      status: 'nieuw',
    });

    const shopName = db.getSetting('shop_name') || 'POS';
    io.to('kitchen').emit('new-order', order);
    printer.printReceipt(order, shopName);
    printer.printKitchenTicket(order, shopName);

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/active', localOnly, (req, res) => {
  try {
    res.json(db.getActiveOrders());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id/status', localOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    const order = db.updateOrderStatus(id, status);

    io.emit('order-status-changed', {
      id: order.id,
      order_number: order.order_number,
      status: order.status,
    });

    // Print kitchen ticket when marked as done
    if (status === 'klaar') {
      const shopName = db.getSetting('shop_name') || 'POS';
      printer.printKitchenTicket(order, shopName);
    }

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin order history
app.get('/api/admin/orders', localOnly, adminAuth, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const orders = db.getOrdersByDate(date);
    const totals = db.getDailyTotals(date);
    res.json({ orders, totals, date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Payment ---

app.post('/api/payment/pin', localOnly, async (req, res) => {
  try {
    const { items, customer_name } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ error: 'Geen items in bestelling' });
    }

    const total = calculateOrderTotal(items);

    // Create order first with pending status
    const order = db.createOrder({
      customer_name: customer_name || '',
      items,
      total,
      payment_method: 'pin',
      origin: 'cashier',
      status: 'wacht_op_betaling',
    });

    const orderReference = `POS-${order.id}-${Date.now()}`;
    const result = await adyenTerminal.initiatePayment(total, orderReference);

    if (result.success) {
      // Update order with payment reference and confirm
      db.updateOrderPayment(order.id, {
        payment_method: 'pin',
        payment_reference: result.reference || '',
        status: 'nieuw',
      });
      const updatedOrder = db.getOrderById(order.id);

      const shopName = db.getSetting('shop_name') || 'POS';
      io.to('kitchen').emit('new-order', updatedOrder);
      printer.printReceipt(updatedOrder, shopName);
      printer.printKitchenTicket(updatedOrder, shopName);

      res.json({ success: true, order: updatedOrder });
    } else {
      // Delete failed order
      db.updateOrderStatus(order.id, 'mislukt');
      res.json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error('Pin betaling fout:', err.message);
    res.status(500).json({ success: false, error: 'Fout bij pinbetaling' });
  }
});

app.post('/api/payment/pin/cancel', localOnly, async (req, res) => {
  try {
    const result = await adyenTerminal.cancelPayment();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Option Groups (Uitbreidingskeuzesets) ---

app.get('/api/admin/option-groups', localOnly, adminAuth, (req, res) => {
  try {
    const groups = db.getAllOptionGroups();
    // Include items for each group
    const result = groups.map(g => ({
      ...g,
      items: db.getOptionGroupItems(g.id),
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/option-groups', localOnly, adminAuth, (req, res) => {
  try {
    const { name, type, max_choices, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: 'Naam is verplicht' });
    const group = db.createOptionGroup({
      name,
      type: type || 'note',
      max_choices: parseInt(max_choices) || 1,
      sort_order: parseInt(sort_order) || 0,
    });
    io.emit('products-updated');
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/option-groups/:id', localOnly, adminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, type, max_choices, sort_order } = req.body;
    db.updateOptionGroup(id, {
      name,
      type: type || 'note',
      max_choices: parseInt(max_choices) || 1,
      sort_order: parseInt(sort_order) || 0,
    });
    io.emit('products-updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/option-groups/:id', localOnly, adminAuth, (req, res) => {
  try {
    db.deleteOptionGroup(parseInt(req.params.id));
    io.emit('products-updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Option group items (add/remove products to/from a group)
app.post('/api/admin/option-groups/:id/items', localOnly, adminAuth, (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { product_id, price_override, sort_order } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Product is verplicht' });
    const item = db.addOptionGroupItem({
      option_group_id: groupId,
      product_id: parseInt(product_id),
      price_override: price_override !== undefined && price_override !== null && price_override !== '' ? parseInt(price_override) : null,
      sort_order: parseInt(sort_order) || 0,
    });
    io.emit('products-updated');
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/option-group-items/:id', localOnly, adminAuth, (req, res) => {
  try {
    db.removeOptionGroupItem(parseInt(req.params.id));
    io.emit('products-updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Product <-> Option Group links
app.get('/api/admin/products/:id/option-groups', localOnly, adminAuth, (req, res) => {
  try {
    res.json(db.getProductOptionGroups(parseInt(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/products/:id/option-groups', localOnly, adminAuth, (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const { option_group_id, sort_order } = req.body;
    if (!option_group_id) return res.status(400).json({ error: 'Keuze groep is verplicht' });
    const link = db.addProductOptionGroup({
      product_id: productId,
      option_group_id: parseInt(option_group_id),
      sort_order: parseInt(sort_order) || 0,
    });
    io.emit('products-updated');
    res.json(link);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/product-option-groups/:id', localOnly, adminAuth, (req, res) => {
  try {
    db.removeProductOptionGroup(parseInt(req.params.id));
    io.emit('products-updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Settings ---

app.get('/api/admin/settings', localOnly, adminAuth, (req, res) => {
  try {
    const settings = db.getAllSettings();
    // Don't expose password hash
    delete settings.admin_password_hash;
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/settings', localOnly, adminAuth, (req, res) => {
  try {
    const { shop_name } = req.body;
    if (shop_name !== undefined) {
      db.setSetting('shop_name', shop_name);
      io.emit('settings-updated', { shop_name });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Printer ---

app.post('/api/printer/test', localOnly, adminAuth, (req, res) => {
  const shopName = db.getSetting('shop_name') || 'POS';
  const result = printer.printTestReceipt(shopName);
  res.json(result);
});

app.post('/api/printer/qr', localOnly, adminAuth, (req, res) => {
  const shopName = db.getSetting('shop_name') || 'POS';
  const publicUrl = process.env.PUBLIC_URL || 'https://bestel.jouwdomein.nl';
  const result = printer.printQRCode(`${publicUrl}/bestel`, shopName);
  res.json(result);
});

// QR code image endpoint (for admin panel display)
app.get('/api/qrcode', localOnly, async (req, res) => {
  try {
    const publicUrl = process.env.PUBLIC_URL || 'https://bestel.jouwdomein.nl';
    const url = `${publicUrl}/bestel`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    res.json({ qrDataUrl, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Socket.io
// ============================================================

io.on('connection', (socket) => {
  socket.on('join', ({ role }) => {
    socket.join(role);
    console.log(`Client verbonden: ${role}`);
  });

  socket.on('update-order-status', ({ order_id, status }) => {
    try {
      const order = db.updateOrderStatus(order_id, status);
      io.emit('order-status-changed', {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
      });

      if (status === 'klaar') {
        const shopName = db.getSetting('shop_name') || 'POS';
        printer.printKitchenTicket(order, shopName);
      }
    } catch (err) {
      console.error('Fout bij status update:', err.message);
    }
  });

  socket.on('ping-check', () => {
    socket.emit('pong-check');
  });

  socket.on('disconnect', () => {
    // Client disconnected
  });
});

// ============================================================
// Start server
// ============================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`POS server draait op poort ${PORT}`);
  console.log(`  Kassier:  http://localhost:${PORT}/cashier`);
  console.log(`  Keuken:   http://localhost:${PORT}/kitchen`);
  console.log(`  Admin:    http://localhost:${PORT}/admin`);
  console.log(`  Bestellen: http://localhost:${PORT}/bestel`);
});
