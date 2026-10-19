const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

let dbPath = path.join(__dirname, 'anugrah.db');

// Handle Vercel Serverless read-only filesystem
if (process.env.VERCEL) {
  const tmpPath = path.join('/tmp', 'anugrah.db');
  try {
    if (!fs.existsSync(tmpPath)) {
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, tmpPath);
      }
    }
    dbPath = tmpPath;
  } catch (err) {
    console.error('Failed to copy db to /tmp on Vercel:', err);
  }
}

const db = new Database(dbPath);

// Enable foreign keys and WAL mode (or standard mode on Vercel /tmp)
try {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (e) {
  console.warn('Pragma warning:', e.message);
}

function initDb() {
  // 1. Settings Table (key-value store for easy dynamic settings)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Users Table (Email or Phone login)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      address TEXT,
      role TEXT DEFAULT 'customer', -- 'customer' or 'admin'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 3. Products Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      category TEXT NOT NULL, -- 'Flagship', 'Mid-Range', 'Entry-Level', 'Second Mulus'
      price INTEGER NOT NULL,
      original_price INTEGER,
      stock INTEGER NOT NULL DEFAULT 5,
      image TEXT NOT NULL,
      description TEXT,
      ram TEXT,
      storage TEXT,
      chipset TEXT,
      screen TEXT,
      battery TEXT,
      camera TEXT,
      warranty TEXT DEFAULT 'Garansi Resmi 1 Tahun',
      is_featured INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 4. Orders Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, -- e.g. ACU-20260923-001
      user_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_email TEXT,
      shipping_address TEXT NOT NULL,
      shipping_method TEXT DEFAULT 'Kurir Toko / Ambil di Cabang',
      pickup_branch TEXT DEFAULT 'Cabang Harjosari (Pusat)',
      payment_method TEXT NOT NULL, -- 'QRIS' or 'Transfer Bank'
      status TEXT DEFAULT 'Menunggu Pembayaran', -- 'Menunggu Pembayaran', 'Diproses', 'Dikirim', 'Selesai', 'Dibatalkan'
      tracking_number TEXT, -- No Resi
      shipping_courier TEXT DEFAULT 'Anugrah Express / J&T',
      total_amount INTEGER NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // 5. Order Items Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      product_image TEXT,
      price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      subtotal INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
  `);

  // 6. Branches Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_main INTEGER DEFAULT 0,
      address TEXT NOT NULL,
      phone TEXT NOT NULL,
      maps_url TEXT,
      opening_hours TEXT DEFAULT '09.00 - 21.00 WIB'
    );
  `);

  // Seed Default Settings if not present
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');

  insertSetting.run('store_name', 'Anugrah Cell Ungaran');
  insertSetting.run('store_tagline', 'Pusat Smartphone Original & Bergaransi Harjosari Kab. Semarang');
  insertSetting.run('whatsapp_admin', '081532128996');
  insertSetting.run('bank_name', 'BCA (Bank Central Asia)');
  insertSetting.run('bank_account', '8910452391');
  insertSetting.run('bank_holder', 'ANUGRAH CELL UNGARAN');
  insertSetting.run('bank_name_2', 'BRI (Bank Rakyat Indonesia)');
  insertSetting.run('bank_account_2', '602101018928531');
  insertSetting.run('bank_holder_2', 'ANUGRAH CELL UNGARAN');
  insertSetting.run('qris_image', '/images/qris-sample.png');
  insertSetting.run('store_address_main', 'Jl. Raya Harjosari No. 88, Harjosari, Bawen / Ungaran, Kab. Semarang');
  insertSetting.run('bot_name', 'Alika');
  insertSetting.run('bot_greeting', 'Halo Kak! Selamat datang di Anugrah Cell Ungaran. Saya Alika, konsultan gadget resmi siap membantu kakak memilih smartphone terbaik bergaransi resmi. Ada yang bisa Alika bantu?');
  const threeActiveKeys = [
    'AQ.Ab8RN6JahjWyf081N76gkwySXTXYMGUOVEWnrwhgRPtjaF4SUg',
    'AQ.Ab8RN6JAhevmcmHWg4SDcRxwrL7ooRnn0wQoc6XcrQSJuM9HAg',
    'AQ.Ab8RN6JFuTplNEXwKYyRN_j-0GDjVqkdFHAuDlWD62ojuz8bHQ'
  ].join('\n');
  const existingKey = getSetting.get('gemini_api_keys');
  if (!existingKey || !existingKey.value || existingKey.value.split('\n').filter(Boolean).length < 3) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('gemini_api_keys', threeActiveKeys);
  }

  // Seed Default Admin User if not present
  const adminCheck = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin');
  if (!adminCheck) {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync('admin123', salt);
    db.prepare(`
      INSERT INTO users (name, email, phone, password, address, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'Administrator Anugrah Cell',
      'admin@anugrahcell.com',
      '081532128996',
      hash,
      'Harjosari, Kab. Semarang',
      'admin'
    );
    console.log('✅ Default Admin created: admin@anugrahcell.com / 081532128996 (pass: admin123)');
  }

  // Seed 3 Branches if empty
  const branchCount = db.prepare('SELECT COUNT(*) as count FROM branches').get().count;
  if (branchCount === 0) {
    const insertBranch = db.prepare(`
      INSERT INTO branches (name, is_main, address, phone, maps_url, opening_hours)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertBranch.run(
      'Cabang 1 - Harjosari (Pusat)',
      1,
      'Jl. Raya Harjosari No. 88, Harjosari, Kec. Bawen / Ungaran, Kab. Semarang (Dekat Pasar Harjosari)',
      '0812-3456-7890',
      'https://maps.google.com/?q=Harjosari+Bawen+Semarang',
      '08.30 - 21.30 WIB (Buka Setiap Hari)'
    );

    insertBranch.run(
      'Cabang 2 - Ungaran Kota',
      0,
      'Jl. Diponegoro No. 142, Genuk, Ungaran Barat, Kab. Semarang',
      '0812-3456-7891',
      'https://maps.google.com/?q=Ungaran+Semarang',
      '09.00 - 21.00 WIB (Buka Setiap Hari)'
    );

    insertBranch.run(
      'Cabang 3 - Bergas / Karangjati',
      0,
      'Jl. Soekarno-Hatta No. 75, Karangjati, Bergas, Kab. Semarang',
      '0812-3456-7892',
      'https://maps.google.com/?q=Karangjati+Bergas+Semarang',
      '09.00 - 21.00 WIB (Buka Setiap Hari)'
    );
    console.log('✅ 3 Cabang Anugrah Cell Kabupaten Semarang initialized');
  }

  // Seed Sample Products if empty
  const productCount = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
  if (productCount === 0) {
    const insertProduct = db.prepare(`
      INSERT INTO products (
        name, brand, category, price, original_price, stock, image, description,
        ram, storage, chipset, screen, battery, camera, warranty, is_featured
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const sampleProducts = [
      {
        name: 'iPhone 15 Pro 128GB Titanium',
        brand: 'Apple',
        category: 'Flagship',
        price: 18499000,
        original_price: 20999000,
        stock: 8,
        image: 'https://images.unsplash.com/photo-1695048133142-1a20484d2569?w=600&auto=format&fit=crop&q=80',
        description: 'iPhone 15 Pro dengan desain titanium kelas dirgantara, chip A17 Pro revolusioner, tombol Tindakan yang dapat disesuaikan, dan sistem kamera Pro yang lebih fleksibel. Garansi Resmi iBox / GDN.',
        ram: '8 GB',
        storage: '128 GB',
        chipset: 'Apple A17 Pro (3 nm)',
        screen: '6.1" Super Retina XDR OLED, 120Hz ProMotion',
        battery: '3274 mAh, Fast Charging 20W',
        camera: '48 MP Main + 12 MP Telephoto 3x + 12 MP Ultrawide',
        warranty: 'Garansi Resmi Apple Indonesia (iBox) 1 Tahun',
        is_featured: 1
      },
      {
        name: 'Samsung Galaxy S24 Ultra 5G 12/256GB',
        brand: 'Samsung',
        category: 'Flagship',
        price: 19999000,
        original_price: 21999000,
        stock: 5,
        image: 'https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?w=600&auto=format&fit=crop&q=80',
        description: 'Galaxy S24 Ultra menghadirkan era baru Galaxy AI. Dilengkapi bodi Titanium, S-Pen terintegrasi, dan kamera 200MP spektakuler dengan zoom optik presisi.',
        ram: '12 GB',
        storage: '256 GB',
        chipset: 'Snapdragon 8 Gen 3 for Galaxy',
        screen: '6.8" Dynamic AMOLED 2X, QHD+, 120Hz, 2600 nits',
        battery: '5000 mAh, Super Fast Charging 45W',
        camera: '200 MP Main + 50 MP Periscope (5x) + 10 MP Telephoto + 12 MP Ultrawide',
        warranty: 'Garansi Resmi SEIN Samsung Indonesia 1 Tahun',
        is_featured: 1
      },
      {
        name: 'Xiaomi 14 12/256GB Leica Lens',
        brand: 'Xiaomi',
        category: 'Flagship',
        price: 11999000,
        original_price: 12999000,
        stock: 10,
        image: 'https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=600&auto=format&fit=crop&q=80',
        description: 'Kamera optik Leica Summilux generasi baru dengan bukaan besar f/1.6. Ditenagai Snapdragon 8 Gen 3 dan desain kompak mewah dengan layar tepi ultra-tipis.',
        ram: '12 GB',
        storage: '256 GB',
        chipset: 'Snapdragon 8 Gen 3',
        screen: '6.36" LTPO OLED, 120Hz, Dolby Vision, 3000 nits',
        battery: '4610 mAh, HyperCharge 90W (100% 31 menit)',
        camera: 'Triple 50 MP Leica Vario-Summilux',
        warranty: 'Garansi Resmi Xiaomi Indonesia 15 Bulan',
        is_featured: 1
      },
      {
        name: 'OPPO Reno 12 Pro 5G 12/512GB',
        brand: 'OPPO',
        category: 'Mid-Range',
        price: 8999000,
        original_price: 9499000,
        stock: 12,
        image: 'https://images.unsplash.com/photo-1580910051074-3eb694886505?w=600&auto=format&fit=crop&q=80',
        description: 'Ponsel AI masa depan dengan desain Fluid Design futuristik dan ketahanan bodi kokoh. Kamera portrait AI kelas studio dengan sensor Sony.',
        ram: '12 GB',
        storage: '512 GB',
        chipset: 'MediaTek Dimensity 7300-Energy',
        screen: '6.7" Quad-Curved AMOLED, 120Hz, HDR10+',
        battery: '5000 mAh, 80W SUPERVOOC',
        camera: '50 MP Sony LYT-600 + 50 MP Telephoto + 8 MP Ultrawide',
        warranty: 'Garansi Resmi OPPO Indonesia 1 Tahun',
        is_featured: 1
      },
      {
        name: 'Vivo V30 5G 12/512GB Aura Light',
        brand: 'Vivo',
        category: 'Mid-Range',
        price: 6499000,
        original_price: 6999000,
        stock: 7,
        image: 'https://images.unsplash.com/photo-1565849904461-04a58ad377e0?w=600&auto=format&fit=crop&q=80',
        description: 'Abadikan potret sempurna dengan All-New Aura Light Portrait yang lebih cerdas. Desain 3D Curved ultra-tipis yang nyaman digenggam sepanjang hari.',
        ram: '12 GB (+12GB Extended)',
        storage: '512 GB',
        chipset: 'Qualcomm Snapdragon 7 Gen 3',
        screen: '6.78" 1.5K AMOLED 120Hz Curved',
        battery: '5000 mAh, 80W FlashCharge',
        camera: 'Dual 50 MP (Main OIS + 50 MP AF Ultrawide)',
        warranty: 'Garansi Resmi Vivo Indonesia 1 Tahun',
        is_featured: 0
      },
      {
        name: 'Infinix Note 40 Pro+ 5G 12/256GB',
        brand: 'Infinix',
        category: 'Mid-Range',
        price: 3699000,
        original_price: 3999000,
        stock: 15,
        image: 'https://images.unsplash.com/photo-1575695342320-d2d2d2f9b73f?w=600&auto=format&fit=crop&q=80',
        description: 'All-Round FastCharge 2.0 100W Multi-Speed + 20W Wireless MagCharge. Layar 3D Curved 120Hz dan kamera 108MP OIS super tajam.',
        ram: '12 GB',
        storage: '256 GB',
        chipset: 'MediaTek Dimensity 7020 5G',
        screen: '6.78" 3D-Curved AMOLED 120Hz',
        battery: '4600 mAh, 100W Wired + 20W Wireless MagCharge',
        camera: '108 MP OIS Super-Zoom Camera',
        warranty: 'Garansi Resmi Infinix Indonesia 1 Tahun',
        is_featured: 0
      },
      {
        name: 'Redmi Note 13 Pro 4G 8/256GB',
        brand: 'Xiaomi',
        category: 'Mid-Range',
        price: 3499000,
        original_price: 3799000,
        stock: 20,
        image: 'https://images.unsplash.com/photo-1511707171634-5f897ff02560?w=600&auto=format&fit=crop&q=80',
        description: 'Kamera ultra-jernih 200MP dengan OIS, Layar AMOLED FHD+ 120Hz, dan pengisian daya turbo 67W dengan baterai tahan lama 5000mAh.',
        ram: '8 GB',
        storage: '256 GB',
        chipset: 'MediaTek Helio G99-Ultra',
        screen: '6.67" AMOLED 120Hz, 1300 nits',
        battery: '5000 mAh, 67W Turbo Charging',
        camera: '200 MP OIS + 8 MP Ultrawide + 2 MP Macro',
        warranty: 'Garansi Resmi Xiaomi Indonesia 15 Bulan',
        is_featured: 0
      },
      {
        name: 'iPhone 13 128GB Midnight (Mulus 99% Garansi Toko)',
        brand: 'Apple',
        category: 'Second Mulus',
        price: 8900000,
        original_price: 10500000,
        stock: 3,
        image: 'https://images.unsplash.com/photo-1510557880182-3d4d3cba35a5?w=600&auto=format&fit=crop&q=80',
        description: 'iPhone 13 Second kondisi 99% mulus luar dalam. Battery Health 90%+, Face ID on, True Tone on, All Provider aman selamanya. Bebas reset.',
        ram: '4 GB',
        storage: '128 GB',
        chipset: 'Apple A15 Bionic',
        screen: '6.1" Super Retina XDR OLED',
        battery: '3240 mAh (BH 92%)',
        camera: 'Dual 12 MP Cinematic Mode',
        warranty: 'Garansi Toko Anugrah Cell 1 Bulan Ganti Unit',
        is_featured: 1
      }
    ];

    for (const p of sampleProducts) {
      insertProduct.run(
        p.name, p.brand, p.category, p.price, p.original_price, p.stock, p.image,
        p.description, p.ram, p.storage, p.chipset, p.screen, p.battery, p.camera,
        p.warranty, p.is_featured
      );
    }
    console.log('✅ Sample Phone Catalog initialized');
  }
}

initDb();

module.exports = {
  db,
  getSettings: () => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    return settings;
  },
  updateSetting: (key, value) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, value);
    try {
      db.pragma('wal_checkpoint(PASSIVE)');
    } catch (_) {}
  }
};
