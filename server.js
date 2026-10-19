const express = require('express');
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const QRCode = require('qrcode');
const { db, getSettings, updateSetting } = require('./database');
const { processChatMessage, testGeminiKey, testAllGeminiKeys, getApiKeys } = require('./gemini-bot');

const app = express();
const PORT = process.env.PORT || 3000;

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static directories
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer Storage Configuration for uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar yang diperbolehkan!'));
    }
  }
});

// Session
app.use(session({
  secret: 'anugrah-cell-ungaran-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));

// Global Template Variables & Helpers
app.use((req, res, next) => {
  const settings = getSettings();
  res.locals.settings = settings;
  res.locals.currentUser = req.session.user || null;
  res.locals.cart = req.session.cart || [];
  
  // Calculate cart count & total
  const cart = req.session.cart || [];
  res.locals.cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  res.locals.cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  // Helper formatting functions
  res.locals.formatRupiah = (number) => {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(number || 0);
  };

  res.locals.formatDate = (dateString) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date);
  };

  next();
});

// Auth Middlewares
function requireLogin(req, res, next) {
  if (!req.session.user) {
    const redirectUrl = req.originalUrl || '/';
    return res.redirect(`/login?redirect=${encodeURIComponent(redirectUrl)}&alert=login_required`);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.redirect('/admin/login?error=unauthorized');
  }
  next();
}

// ==========================================
// REAL-TIME PARALLEL LIVE SYNC (SSE)
// ==========================================
let sseClients = [];

function broadcastLiveEvent(eventType, data = {}) {
  const payload = JSON.stringify({ type: eventType, data, timestamp: Date.now() });
  sseClients.forEach(client => {
    try {
      client.res.write(`data: ${payload}\n\n`);
    } catch (e) {
      // client disconnected
    }
  });
}

// SSE Connection Endpoint for Browser Clients
app.get('/api/live-sync', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const clientId = Date.now() + '-' + Math.random();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date() })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// Keep-alive heartbeat every 20s
setInterval(() => {
  sseClients.forEach(client => {
    try {
      client.res.write(`: heartbeat\n\n`);
    } catch (e) {}
  });
}, 20000);

// ==========================================
// PUBLIC & SHOP ROUTES
// ==========================================

// Homepage
app.get('/', (req, res) => {
  const featuredProducts = db.prepare('SELECT * FROM products WHERE is_featured = 1 ORDER BY id DESC LIMIT 8').all();
  const latestProducts = db.prepare('SELECT * FROM products ORDER BY id DESC LIMIT 8').all();
  const branches = db.prepare('SELECT * FROM branches ORDER BY is_main DESC, id ASC').all();
  const brands = db.prepare('SELECT DISTINCT brand FROM products ORDER BY brand ASC').all().map(b => b.brand);

  res.render('index', {
    title: 'Anugrah Cell Ungaran - Pusat HP Original & Bergaransi Harjosari Kab. Semarang',
    featuredProducts,
    latestProducts,
    branches,
    brands
  });
});

// Catalog Page with Search & Filters
app.get('/katalog', (req, res) => {
  const { brand, category, search, sort } = req.query;
  let query = 'SELECT * FROM products WHERE 1=1';
  const params = [];

  if (brand && brand !== 'Semua') {
    query += ' AND brand = ?';
    params.push(brand);
  }

  if (category && category !== 'Semua') {
    query += ' AND category = ?';
    params.push(category);
  }

  if (search) {
    query += ' AND (name LIKE ? OR brand LIKE ? OR description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (sort === 'termurah') {
    query += ' ORDER BY price ASC';
  } else if (sort === 'termahal') {
    query += ' ORDER BY price DESC';
  } else {
    query += ' ORDER BY id DESC';
  }

  const products = db.prepare(query).all(...params);
  const brands = db.prepare('SELECT DISTINCT brand FROM products ORDER BY brand ASC').all().map(b => b.brand);
  const categories = ['Flagship', 'Mid-Range', 'Entry-Level', 'Second Mulus'];

  res.render('catalog', {
    title: 'Katalog Ponsel Original - Anugrah Cell Ungaran',
    products,
    brands,
    categories,
    selectedBrand: brand || 'Semua',
    selectedCategory: category || 'Semua',
    searchQuery: search || '',
    selectedSort: sort || 'terbaru'
  });
});

// Product Detail Page
app.get('/produk/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) {
    return res.status(404).send('Produk tidak ditemukan');
  }

  const relatedProducts = db.prepare('SELECT * FROM products WHERE (brand = ? OR category = ?) AND id != ? LIMIT 4').all(
    product.brand,
    product.category,
    product.id
  );

  const branches = db.prepare('SELECT * FROM branches ORDER BY is_main DESC, id ASC').all();

  res.render('product-detail', {
    title: `${product.name} - Anugrah Cell Ungaran`,
    product,
    relatedProducts,
    branches
  });
});

// ==========================================
// DIRECT BUY (BELI LANGSUNG TANPA KERANJANG)
// ==========================================

// Direct Buy via GET /beli-langsung/:id (from catalog / home card)
app.get('/beli-langsung/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) {
    return res.redirect('/katalog');
  }

  req.session.cart = [{
    id: product.id,
    name: product.name,
    price: product.price,
    image: product.image,
    brand: product.brand,
    warranty: product.warranty,
    quantity: 1
  }];

  res.redirect('/checkout');
});

// Direct Buy via POST /beli-langsung (from product detail page with custom quantity)
app.post('/beli-langsung', (req, res) => {
  const { productId, quantity } = req.body;
  const qty = parseInt(quantity, 10) || 1;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);

  if (!product) {
    return res.redirect('/katalog');
  }

  req.session.cart = [{
    id: product.id,
    name: product.name,
    price: product.price,
    image: product.image,
    brand: product.brand,
    warranty: product.warranty,
    quantity: qty
  }];

  res.redirect('/checkout');
});

// Redirect any legacy /cart visits directly to catalog
app.get('/cart', (req, res) => {
  res.redirect('/katalog');
});
app.post('/cart/add', (req, res) => {
  const { productId, quantity } = req.body;
  const qty = parseInt(quantity, 10) || 1;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (product) {
    req.session.cart = [{
      id: product.id,
      name: product.name,
      price: product.price,
      image: product.image,
      brand: product.brand,
      warranty: product.warranty,
      quantity: qty
    }];
  }
  res.redirect('/checkout');
});

// ==========================================
// CHECKOUT & ORDERS (MANDATORY LOGIN)
// ==========================================

// Checkout Page (Must be logged in)
app.get('/checkout', requireLogin, (req, res) => {
  if (!req.session.cart || req.session.cart.length === 0) {
    return res.redirect('/katalog');
  }

  const branches = db.prepare('SELECT * FROM branches ORDER BY is_main DESC, id ASC').all();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

  res.render('checkout', {
    title: 'Checkout Pembayaran - Anugrah Cell Ungaran',
    user,
    branches
  });
});

// Process Checkout
app.post('/checkout', requireLogin, (req, res) => {
  const cart = req.session.cart;
  if (!cart || cart.length === 0) {
    return res.redirect('/cart');
  }

  const {
    customer_name,
    customer_phone,
    customer_email,
    shipping_address,
    shipping_method,
    pickup_branch,
    payment_method,
    notes
  } = req.body;

  const totalAmount = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  // Generate unique Order ID
  const today = new Date();
  const dateStr = today.getFullYear().toString() +
    String(today.getMonth() + 1).padStart(2, '0') +
    String(today.getDate()).padStart(2, '0');
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const orderId = `ACU-${dateStr}-${randomSuffix}`;

  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, user_id, customer_name, customer_phone, customer_email,
      shipping_address, shipping_method, pickup_branch, payment_method,
      status, tracking_number, shipping_courier, total_amount, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertOrderItem = db.prepare(`
    INSERT INTO order_items (
      order_id, product_id, product_name, product_image, price, quantity, subtotal
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Transaction for order placement
  const executeOrder = db.transaction(() => {
    insertOrder.run(
      orderId,
      req.session.user.id,
      customer_name,
      customer_phone,
      customer_email || req.session.user.email,
      shipping_address,
      shipping_method,
      pickup_branch,
      payment_method,
      'Menunggu Pembayaran',
      '',
      'Kurir Toko Anugrah Cell',
      totalAmount,
      notes || ''
    );

    for (const item of cart) {
      insertOrderItem.run(
        orderId,
        item.id,
        item.name,
        item.image,
        item.price,
        item.quantity,
        item.price * item.quantity
      );

      // Decrement stock
      db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?').run(item.quantity, item.id);
    }
  });

  executeOrder();

  // Broadcast to all connected clients & admin
  broadcastLiveEvent('order_placed', { orderId, total: totalAmount, customer: customer_name });
  broadcastLiveEvent('product_changed');

  // Clear cart
  req.session.cart = [];

  res.redirect(`/order-success/${orderId}`);
});

// Order Success & WhatsApp Integration
app.get('/order-success/:id', requireLogin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!order) {
    return res.status(404).send('Pesanan tidak ditemukan');
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  const settings = getSettings();

  // Build formatted WhatsApp message
  let itemLines = items.map((item, idx) => `${idx + 1}. *${item.product_name}* (x${item.quantity}) - ${res.locals.formatRupiah(item.subtotal)}`).join('%0A');
  
  const waNumber = (settings.whatsapp_admin || '6281532128996').replace(/\D/g, '');
  const waMessage = 
`*PESANAN BARU - ANUGRAH CELL UNGARAN*%0A` +
`----------------------------------------%0A` +
`*No. Pesanan:* ${order.id}%0A` +
`*Nama Pemesan:* ${order.customer_name}%0A` +
`*No. WhatsApp/HP:* ${order.customer_phone}%0A` +
`*Alamat / Pengambilan:* ${order.shipping_method === 'Ambil di Toko' ? order.pickup_branch : order.shipping_address}%0A` +
`*Metode Bayar:* ${order.payment_method}%0A` +
`----------------------------------------%0A` +
`*Detail Barang:*%0A${itemLines}%0A` +
`----------------------------------------%0A` +
`*TOTAL TAGIHAN:* ${res.locals.formatRupiah(order.total_amount)}%0A` +
`*Catatan:* ${order.notes || '-'}%0A%0A` +
`Halo Admin Anugrah Cell, saya telah memesan ponsel melalui website. Mohon segera diproses dan diverifikasi. Terima kasih! 🙏`;

  const waLink = `https://wa.me/${waNumber}?text=${waMessage}`;

  res.render('order-success', {
    title: 'Pesanan Berhasil Dibuat - Anugrah Cell Ungaran',
    order,
    items,
    waLink
  });
});

// Customer's Order History
app.get('/pesanan-saya', requireLogin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  
  // Attach items to each order
  const ordersWithItems = orders.map(ord => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(ord.id);
    return { ...ord, items };
  });

  res.render('my-orders', {
    title: 'Riwayat Pesanan Saya - Anugrah Cell Ungaran',
    orders: ordersWithItems
  });
});

// Customer's Account Profile Page
app.get('/akun', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const orderCount = db.prepare('SELECT COUNT(*) as count FROM orders WHERE user_id = ?').get(req.session.user.id).count;

  res.render('account', {
    title: 'Akun Saya - Anugrah Cell Ungaran',
    user,
    orderCount,
    activePage: 'account'
  });
});

// ==========================================
// AUTHENTICATION (EMAIL OR PHONE + PASSWORD)
// ==========================================

// Login Page
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/');
  }
  res.render('auth/login', {
    title: 'Masuk Akun - Anugrah Cell Ungaran',
    redirect: req.query.redirect || '/',
    alert: req.query.alert || null,
    error: null
  });
});

// Process Login (Supports EMAIL OR PHONE NUMBER)
app.post('/login', (req, res) => {
  const { identifier, password, redirect } = req.body;

  if (!identifier || !password) {
    return res.render('auth/login', {
      title: 'Masuk Akun - Anugrah Cell Ungaran',
      redirect: redirect || '/',
      alert: null,
      error: 'Silakan masukkan Email / No. Ponsel dan kata sandi!'
    });
  }

  // Find user by either email OR phone
  const cleanPhone = identifier.replace(/[\s-]/g, '');
  const user = db.prepare('SELECT * FROM users WHERE email = ? OR phone = ? OR phone = ?').get(identifier, identifier, cleanPhone);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('auth/login', {
      title: 'Masuk Akun - Anugrah Cell Ungaran',
      redirect: redirect || '/',
      alert: null,
      error: 'Email / Nomor Ponsel atau Kata Sandi salah!'
    });
  }

  // Set session
  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    address: user.address,
    role: user.role
  };

  const destination = redirect && redirect.startsWith('/') ? redirect : (user.role === 'admin' ? '/admin' : '/');
  res.redirect(destination);
});

// Register Page
app.get('/daftar', (req, res) => {
  if (req.session.user) {
    return res.redirect('/');
  }
  res.render('auth/register', {
    title: 'Daftar Akun Baru - Anugrah Cell Ungaran',
    redirect: req.query.redirect || '/',
    error: null,
    form: {}
  });
});

// Process Register
app.post('/daftar', (req, res) => {
  const { name, email, phone, password, confirm_password, address, redirect } = req.body;

  if (!name || !phone || !password) {
    return res.render('auth/register', {
      title: 'Daftar Akun Baru - Anugrah Cell Ungaran',
      redirect: redirect || '/',
      error: 'Nama, No. Ponsel, dan Kata Sandi wajib diisi!',
      form: req.body
    });
  }

  if (password !== confirm_password) {
    return res.render('auth/register', {
      title: 'Daftar Akun Baru - Anugrah Cell Ungaran',
      redirect: redirect || '/',
      error: 'Konfirmasi kata sandi tidak cocok!',
      form: req.body
    });
  }

  const cleanPhone = phone.replace(/[\s-]/g, '');

  // Check if phone or email already registered
  const existing = (email && email.trim() !== '')
    ? db.prepare('SELECT id FROM users WHERE phone = ? OR email = ?').get(cleanPhone, email.trim())
    : db.prepare('SELECT id FROM users WHERE phone = ?').get(cleanPhone);
  if (existing) {
    return res.render('auth/register', {
      title: 'Daftar Akun Baru - Anugrah Cell Ungaran',
      redirect: redirect || '/',
      error: 'Nomor Ponsel atau Email sudah terdaftar! Silakan langsung masuk.',
      form: req.body
    });
  }

  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(password, salt);

  const insertUser = db.prepare(`
    INSERT INTO users (name, email, phone, password, address, role)
    VALUES (?, ?, ?, ?, ?, 'customer')
  `);

  const result = insertUser.run(name, email || null, cleanPhone, hash, address || '');

  // Log user in automatically
  req.session.user = {
    id: result.lastInsertRowid,
    name: name,
    email: email || null,
    phone: cleanPhone,
    address: address || '',
    role: 'customer'
  };

  const destination = redirect && redirect.startsWith('/') ? redirect : '/';
  res.redirect(destination);
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// ==========================================
// ADMIN PANEL
// ==========================================

// Admin Login
app.get('/admin/login', (req, res) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return res.redirect('/admin');
  }
  res.render('admin/login', {
    title: 'Login Panel Admin - Anugrah Cell Ungaran',
    error: req.query.error ? 'Akses ditolak atau sesi habis' : null
  });
});

app.post('/admin/login', (req, res) => {
  const { identifier, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE (email = ? OR phone = ?) AND role = 'admin'").get(identifier, identifier);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('admin/login', {
      title: 'Login Panel Admin - Anugrah Cell Ungaran',
      error: 'Kredensial Admin tidak valid!'
    });
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: 'admin'
  };

  res.redirect('/admin');
});

// Admin Dashboard
app.get('/admin', requireAdmin, (req, res) => {
  const totalProducts = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
  const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
  const totalRevenue = db.prepare("SELECT SUM(total_amount) as sum FROM orders WHERE status != 'Dibatalkan'").get().sum || 0;
  const pendingOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'Menunggu Pembayaran'").get().count;

  const recentOrders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 6').all();
  const lowStock = db.prepare('SELECT * FROM products WHERE stock <= 3 ORDER BY stock ASC LIMIT 5').all();

  res.render('admin/dashboard', {
    title: 'Dashboard Admin - Anugrah Cell Ungaran',
    totalProducts,
    totalOrders,
    totalRevenue,
    pendingOrders,
    recentOrders,
    lowStock
  });
});

// Admin Products List
app.get('/admin/produk', requireAdmin, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  res.render('admin/products', {
    title: 'Kelola Katalog Produk - Anugrah Cell',
    products,
    success: req.query.success || null
  });
});

// Admin Add Product Form
app.get('/admin/produk/tambah', requireAdmin, (req, res) => {
  res.render('admin/product-form', {
    title: 'Tambah Ponsel Baru - Anugrah Cell',
    product: null,
    isEdit: false
  });
});

// Admin Save New Product
app.post('/admin/produk/tambah', requireAdmin, upload.single('image_file'), (req, res) => {
  const {
    name, brand, category, price, original_price, stock,
    image_url, description, ram, storage, chipset, screen,
    battery, camera, warranty, is_featured
  } = req.body;

  let image = image_url;
  if (req.file) {
    image = `/uploads/${req.file.filename}`;
  }

  if (!image) {
    image = 'https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=600&auto=format&fit=crop&q=80';
  }

  const insert = db.prepare(`
    INSERT INTO products (
      name, brand, category, price, original_price, stock, image, description,
      ram, storage, chipset, screen, battery, camera, warranty, is_featured
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    name,
    brand,
    category,
    parseInt(price, 10) || 0,
    original_price ? parseInt(original_price, 10) : null,
    parseInt(stock, 10) || 0,
    image,
    description,
    ram,
    storage,
    chipset,
    screen,
    battery,
    camera,
    warranty || 'Garansi Resmi 1 Tahun',
    is_featured ? 1 : 0
  );

  broadcastLiveEvent('product_changed');
  res.redirect('/admin/produk?success=added');
});

// Admin Edit Product Form
app.get('/admin/produk/edit/:id', requireAdmin, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).send('Produk tidak ditemukan');

  res.render('admin/product-form', {
    title: `Edit Produk: ${product.name} - Anugrah Cell`,
    product,
    isEdit: true
  });
});

// Admin Update Product
app.post('/admin/produk/edit/:id', requireAdmin, upload.single('image_file'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).send('Produk tidak ditemukan');

  const {
    name, brand, category, price, original_price, stock,
    image_url, description, ram, storage, chipset, screen,
    battery, camera, warranty, is_featured
  } = req.body;

  let image = product.image;
  if (req.file) {
    image = `/uploads/${req.file.filename}`;
  } else if (image_url && image_url.trim()) {
    image = image_url.trim();
  }

  const update = db.prepare(`
    UPDATE products SET
      name = ?, brand = ?, category = ?, price = ?, original_price = ?,
      stock = ?, image = ?, description = ?, ram = ?, storage = ?,
      chipset = ?, screen = ?, battery = ?, camera = ?, warranty = ?, is_featured = ?
    WHERE id = ?
  `);

  update.run(
    name,
    brand,
    category,
    parseInt(price, 10) || 0,
    original_price ? parseInt(original_price, 10) : null,
    parseInt(stock, 10) || 0,
    image,
    description,
    ram,
    storage,
    chipset,
    screen,
    battery,
    camera,
    warranty,
    is_featured ? 1 : 0,
    req.params.id
  );

  broadcastLiveEvent('product_changed', { productId: req.params.id });
  res.redirect('/admin/produk?success=updated');
});

// Quick Price Update Route (Realtime)
app.post('/admin/produk/quick-price/:id', requireAdmin, (req, res) => {
  const { price, original_price } = req.body;
  const p = parseInt(price, 10);
  const orig = original_price ? parseInt(original_price, 10) : null;
  if (!isNaN(p) && p >= 0) {
    db.prepare('UPDATE products SET price = ?, original_price = ? WHERE id = ?').run(p, orig, req.params.id);
    broadcastLiveEvent('product_changed', { productId: req.params.id, price: p });
  }
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ success: true, price: p });
  }
  res.redirect('/admin/produk?success=price_updated');
});

// Admin Delete Product
app.post('/admin/produk/hapus/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  broadcastLiveEvent('product_changed', { productId: req.params.id, deleted: true });
  res.redirect('/admin/produk?success=deleted');
});

// Admin Orders List
app.get('/admin/pesanan', requireAdmin, (req, res) => {
  const statusFilter = req.query.status;
  let query = 'SELECT * FROM orders';
  const params = [];

  if (statusFilter && statusFilter !== 'Semua') {
    query += ' WHERE status = ?';
    params.push(statusFilter);
  }

  query += ' ORDER BY created_at DESC';

  const orders = db.prepare(query).all(...params);
  const ordersWithItems = orders.map(ord => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(ord.id);
    return { ...ord, items };
  });

  res.render('admin/orders', {
    title: 'Kelola Pesanan & Resi - Anugrah Cell',
    orders: ordersWithItems,
    selectedStatus: statusFilter || 'Semua',
    success: req.query.success || null
  });
});

// Admin Update Order Status
app.post('/admin/pesanan/status/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
  broadcastLiveEvent('order_status_updated', { orderId: req.params.id, status });
  res.redirect('/admin/pesanan?success=status_updated');
});

// Admin Input / Update Resi Pengiriman
app.post('/admin/pesanan/resi/:id', requireAdmin, (req, res) => {
  const { tracking_number, shipping_courier } = req.body;
  
  db.prepare(`
    UPDATE orders 
    SET tracking_number = ?, shipping_courier = ?, status = 'Dikirim', updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).run(tracking_number, shipping_courier, req.params.id);

  broadcastLiveEvent('order_status_updated', { orderId: req.params.id, status: 'Dikirim', tracking_number });
  res.redirect('/admin/pesanan?success=resi_updated');
});

// Admin Printable Resi / Invoice
app.get('/admin/pesanan/resi-cetak/:id', requireAdmin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('Pesanan tidak ditemukan');

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  const settings = getSettings();

  // Generate QR Code data URL for the receipt
  const qrDataUrl = await QRCode.toDataURL(`ANUGRAHCELL-RESI:${order.id}:${order.tracking_number || 'REG'}`, {
    margin: 1,
    width: 140
  });

  res.render('admin/receipt', {
    title: `Resi Pengiriman #${order.id} - Anugrah Cell Ungaran`,
    order,
    items,
    settings,
    qrDataUrl
  });
});

// Admin Settings Page (WhatsApp, QRIS, Bank Account, Cabang)
app.get('/admin/pengaturan', requireAdmin, (req, res) => {
  const settings = getSettings();
  const branches = db.prepare('SELECT * FROM branches ORDER BY id ASC').all();

  res.render('admin/settings', {
    title: 'Pengaturan Toko & WhatsApp - Anugrah Cell',
    settings,
    branches,
    success: req.query.success || null
  });
});

// Admin Save Settings
app.post('/admin/pengaturan', requireAdmin, upload.single('qris_file'), (req, res) => {
  const {
    whatsapp_admin,
    bank_name,
    bank_account,
    bank_holder,
    bank_name_2,
    bank_account_2,
    bank_holder_2,
    store_name,
    store_tagline,
    store_address_main,
    gemini_api_keys,
    bot_name,
    bot_greeting
  } = req.body;

  if (whatsapp_admin) updateSetting('whatsapp_admin', whatsapp_admin.trim());
  if (bank_name) updateSetting('bank_name', bank_name.trim());
  if (bank_account) updateSetting('bank_account', bank_account.trim());
  if (bank_holder) updateSetting('bank_holder', bank_holder.trim());
  if (bank_name_2) updateSetting('bank_name_2', bank_name_2.trim());
  if (bank_account_2) updateSetting('bank_account_2', bank_account_2.trim());
  if (bank_holder_2) updateSetting('bank_holder_2', bank_holder_2.trim());
  if (store_name) updateSetting('store_name', store_name.trim());
  if (store_tagline) updateSetting('store_tagline', store_tagline.trim());
  if (store_address_main) updateSetting('store_address_main', store_address_main.trim());
  if (typeof gemini_api_keys !== 'undefined') {
    const cleanedKeys = gemini_api_keys
      .split(/[\n,;]+/)
      .map(k => k.trim())
      .filter(k => k.length >= 10)
      .join('\n');
    updateSetting('gemini_api_keys', cleanedKeys);
    console.log(`[Admin] Saved ${cleanedKeys ? cleanedKeys.split('\n').length : 0} Gemini API keys via form submit.`);
  }
  if (bot_name) updateSetting('bot_name', bot_name.trim());
  if (bot_greeting) updateSetting('bot_greeting', bot_greeting.trim());

  if (req.file) {
    updateSetting('qris_image', `/uploads/${req.file.filename}`);
  }

  broadcastLiveEvent('settings_changed');
  res.redirect('/admin/pengaturan?success=settings_saved');
});

// Admin Instant Save & Activate Gemini API Keys
app.post('/admin/save-gemini-keys', requireAdmin, (req, res) => {
  try {
    const rawKeys = req.body.keys || req.body.gemini_api_keys || '';
    const cleaned = rawKeys
      .split(/[\n,;]+/)
      .map(k => k.trim())
      .filter(k => k.length >= 10);
    const savedString = cleaned.join('\n');
    updateSetting('gemini_api_keys', savedString);
    broadcastLiveEvent('settings_changed');
    console.log(`[Admin] Instant saved & activated ${cleaned.length} Gemini API keys to database.`);
    res.json({
      ok: true,
      count: cleaned.length,
      keysList: cleaned.map((k, idx) => ({
        index: idx + 1,
        maskedKey: k.substring(0, 10) + '...' + k.substring(k.length - 4)
      })),
      message: `✅ Berhasil menyimpan ${cleaned.length} API Key ke Database! Seluruh key sekarang langsung AKTIF untuk otak Alika.`
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Gagal menyimpan ke database: ' + err.message });
  }
});

// Admin Test All Gemini Keys & Auto-Save to Database
app.post('/admin/test-gemini-key', requireAdmin, async (req, res) => {
  try {
    const rawKeys = req.body.keys || req.body.key || '';
    const cleaned = rawKeys
      .split(/[\n,;]+/)
      .map(k => k.trim())
      .filter(k => k.length >= 10);

    // Automatically save to database so keys are immediately active!
    if (cleaned.length > 0) {
      updateSetting('gemini_api_keys', cleaned.join('\n'));
      broadcastLiveEvent('settings_changed');
      console.log(`[Admin] Auto-saved ${cleaned.length} Gemini API keys during connection test.`);
    }

    const result = await testAllGeminiKeys(rawKeys);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Chatbot Consultation API (Real-Time Gemini AI + Live Catalog Context + Fallback)
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
    }
    const result = await processChatMessage(message.trim(), history || []);
    res.json(result);
  } catch (err) {
    console.error('Chatbot API error:', err);
    res.status(500).json({ 
      reply: 'Maaf Kak, saat ini sedang terjadi kendala jaringan. Kakak bisa langsung klik [Hubungi WhatsApp Admin (0815-3212-8996)](https://wa.me/6281532128996) untuk respon cepat ya!',
      source: 'error_fallback'
    });
  }
});

// Admin Update Branch Info
app.post('/admin/cabang/edit/:id', requireAdmin, (req, res) => {
  const { name, address, phone, opening_hours, maps_url } = req.body;
  db.prepare(`
    UPDATE branches 
    SET name = ?, address = ?, phone = ?, opening_hours = ?, maps_url = ?
    WHERE id = ?
  `).run(name, address, phone, opening_hours, maps_url, req.params.id);

  broadcastLiveEvent('branch_changed');
  res.redirect('/admin/pengaturan?success=branch_updated');
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Anugrah Cell Ungaran Server running at http://localhost:${PORT}`);
  console.log(`🔐 Admin Panel: http://localhost:${PORT}/admin (Login: admin@anugrahcell.com / admin123)`);
});
