const { db, getSettings } = require('./database');

// Format Rupiah helper
function formatRp(num) {
  if (!num) return 'Rp 0';
  return 'Rp ' + Number(num).toLocaleString('id-ID');
}

/**
 * Clean & extract array of Gemini API keys from settings/env
 */
function getApiKeys() {
  const settings = getSettings();
  const dbRaw = (settings && settings.gemini_api_keys) ? settings.gemini_api_keys.trim() : '';
  const envRaw = (process.env.GEMINI_API_KEY || '').trim();

  const keys = [];
  if (dbRaw) {
    dbRaw.split(/[\n,;]+/).forEach(k => {
      const clean = k.trim();
      if (clean.length >= 10 && !keys.includes(clean)) keys.push(clean);
    });
  }
  if (envRaw) {
    envRaw.split(/[\n,;]+/).forEach(k => {
      const clean = k.trim();
      if (clean.length >= 10 && !keys.includes(clean)) keys.push(clean);
    });
  }
  return keys;
}

/**
 * Fetch all available products with live specs & stock from DB
 */
function getCatalogContext() {
  const products = db.prepare(`
    SELECT id, name, brand, category, price, original_price, stock, 
           ram, storage, chipset, screen, battery, camera, warranty, is_featured
    FROM products 
    ORDER BY stock DESC, price ASC
  `).all();

  const branches = db.prepare(`
    SELECT name, is_main, address, phone, opening_hours FROM branches
  `).all();

  const settings = getSettings();

  return { products, branches, settings };
}

/**
 * Test a Gemini API key with latest models (gemini-3.6-flash, gemini-flash-latest, etc)
 */
async function testGeminiKey(apiKey) {
  if (!apiKey || apiKey.length < 10) {
    return { ok: false, message: 'Format API Key tidak valid (terlalu pendek).' };
  }

  const cleanKey = apiKey.trim();
  const models = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-3.6-flash'];
  let lastError = '';

  for (const model of models) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 18000);
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': cleanKey
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Tes' }] }],
          generationConfig: { maxOutputTokens: 5 }
        })
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        return { ok: true, model, message: `✅ Aktif & Valid (Model: ${model})` };
      }

      const data = await res.json().catch(() => ({}));
      const errMsg = data.error?.message || res.statusText || 'Gagal memverifikasi key.';

      if (res.status === 429) {
        return { ok: true, model, message: `⚠️ Valid (Status 429: Kuota terpakai, siap rotasi otomatis)` };
      }

      if (res.status === 404 || res.status === 503 || res.status === 500) {
        lastError = `Model ${model} sedang sibuk/tidak tersedia (${res.status}).`;
        continue;
      }

      return { 
        ok: false, 
        message: `❌ Error (${res.status}): ${errMsg}` 
      };
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err.name === 'AbortError' ? 'Timeout koneksi' : err.message;
    }
  }

  return { ok: false, message: `❌ Gagal memverifikasi: ${lastError}` };
}

/**
 * Test and verify ALL keys provided in multi-line input
 */
async function testAllGeminiKeys(rawInput) {
  const keyList = (rawInput || '')
    .split(/[\n,;]+/)
    .map(k => k.trim())
    .filter(k => k.length >= 10);

  if (keyList.length === 0) {
    return { ok: false, total: 0, validCount: 0, results: [], message: 'Harap masukkan minimal 1 API Key yang valid.' };
  }

  // Test all keys concurrently for fast feedback
  const results = await Promise.all(keyList.map(async (k, idx) => {
    const masked = k.substring(0, 10) + '...' + k.substring(k.length - 4);
    const res = await testGeminiKey(k);
    return {
      index: idx + 1,
      maskedKey: masked,
      ok: res.ok,
      message: res.message
    };
  }));

  const validCount = results.filter(r => r.ok).length;
  return {
    ok: validCount > 0,
    total: keyList.length,
    validCount,
    results,
    message: validCount > 0
      ? `✅ Tersimpan di Database! ${validCount} dari ${keyList.length} API Key Aktif & Siap Rotasi Otomatis.`
      : `⚠️ Key disimpan ke Database, namun gagal diverifikasi. Pastikan API Key benar.`
  };
}

let keyRotationCursor = 0;

/**
 * Call Gemini with multi-key rotation, rich conversation memory, and auto-failover
 */
async function callGeminiWithRotation(keys, systemPrompt, userMessage, chatHistory = []) {
  // Prioritize Google Gemini's latest token-frugal models
  const models = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-3.6-flash'];

  // 1. Build clean, alternating multi-turn memory for Gemini
  const contents = [];

  if (Array.isArray(chatHistory) && chatHistory.length > 0) {
    // Keep up to 6 recent messages for context without bloating prompt tokens
    const recent = chatHistory.slice(-6);

    for (const item of recent) {
      if (!item || !item.text || !item.text.trim()) continue;
      const role = (item.sender === 'user') ? 'user' : 'model';

      // Ensure strict alternation: combine consecutive identical roles
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += '\n' + item.text.trim();
      } else {
        contents.push({ role, parts: [{ text: item.text.trim() }] });
      }
    }
  }

  // Ensure conversation ends with the current user message
  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: [{ text: userMessage }] });
  } else {
    // If the frontend already included this message as the last user turn, verify text
    if (contents[contents.length - 1].parts[0].text !== userMessage) {
      contents[contents.length - 1].parts[0].text = userMessage;
    }
  }

  // Ensure conversation starts with 'user' role
  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  // Fallback if empty
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: userMessage }] });
  }

  const startIndex = keyRotationCursor % keys.length;
  keyRotationCursor++;

  for (let step = 0; step < keys.length; step++) {
    const i = (startIndex + step) % keys.length;
    const currentKey = keys[i].trim();
    for (const model of models) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout to allow safe network completion
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(currentKey)}`;
        const resp = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 
            'Content-Type': 'application/json',
            'x-goog-api-key': currentKey
          },
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: systemPrompt }]
            },
            contents,
            generationConfig: {
              temperature: 0.75, // natural, expressive, creative
              maxOutputTokens: 500
            }
          })
        });
        clearTimeout(timeoutId);

        if (resp.ok) {
          const data = await resp.json();
          const candidateParts = data.candidates?.[0]?.content?.parts || [];
          const candidateText = candidateParts.map(p => p.text).filter(Boolean).join('\n\n');
          if (candidateText && candidateText.trim()) {
            return { ok: true, text: candidateText.trim(), keyUsedIndex: i, modelUsed: model };
          }
        }

        if (resp.status === 404) {
          continue;
        }

        if (resp.status === 429 || resp.status === 400 || resp.status === 403 || resp.status === 503 || resp.status === 500) {
          console.warn(`[Gemini Bot] Key #${i + 1} (${model}) status ${resp.status}, trying next...`);
          continue; // Try next model in list
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          console.warn(`[Gemini Bot] Timeout (>25s) on ${model}, trying next...`);
          continue;
        }
      }
    }
  }

  return { ok: false, message: 'All Gemini API keys exhausted or offline.' };
}

/**
 * Intelligent Built-in Sales & Knowledge Engine (Fallback & Direct Consultant)
 * Fully understands phone specifications, stock, branches, payment, and closing!
 */
function buildLocalSalesResponse(userMessage, catalogContext) {
  const { products, branches, settings } = catalogContext;
  const msg = userMessage.toLowerCase();
  const botName = settings.bot_name || 'Alika';
  const waNumber = (settings.whatsapp_admin || '081532128996').replace(/\D/g, '');

  // 0. Chit-chat, Feelings, Compliments & Human-like Casual Interaction
  if (msg.includes('cantik') || msg.includes('manis') || msg.includes('lucu') || msg.includes('pintar') || msg.includes('sayang') || msg.includes('imut')) {
    return `Ih Kakak bisa aja dehh, bikin Alika jadi salting gini hehe~ 🙈🥰 Makasih banyak yaa Kak! Kakak juga pasti orangnya asyik dan super ramah. Btw, lagi pengen cari HP idaman apa nih Kakak manis? Alika siap pilihin yang paling juara buat Kakak! ✨📱`;
  }

  if (msg.includes('pusing') || msg.includes('capek') || msg.includes('lelah') || msg.includes('ngantuk') || msg.includes('curhat') || msg.includes('laper') || msg.includes('lapar') || msg.includes('stres')) {
    return `Ya ampun Kakak... Alika peluk jauh dulu yaa! 🤗 Jangan terlalu diforsir kerjanya Kak, istirahat dulu sebentar, minum air anget. Alika temenin di sini kok santai-santai~ 🥰 Kalau pikiran udah agak adem, mau Alika temenin liat-liat promo HP kece gak nih? 😉🌸`;
  }

  if (msg.includes('kamu siapa') || msg.includes('siapa kamu') || msg.includes('kamu orang') || msg.includes('kamu bot') || msg.includes('kamu robot') || msg.includes('kenalan')) {
    return `Halo Kakak! Kenalin, aku **Alika** 🌸 sahabat sekaligus konsultan gadget resmi di **Anugrah Cell Ungaran**. Alika orangnya ramah, ceria, dan siap nemenin Kakak cari HP idaman sampai dapet harga paling hemat dan bergaransi resmi! Seneng banget bisa kenal sama Kakak~ 🥰`;
  }

  const nameMatch = msg.match(/(?:namaku|nama saya|kenalin aku|panggil aku)\s+([a-zA-Z]+)/i);
  if (nameMatch) {
    const userName = nameMatch[1];
    return `Wah, salam kenal Kak **${userName}**! 💖 Seneng banget deh Alika bisa ngobrol sama Kak ${userName}~ Sekarang Alika udah inget ya nama Kakak! Mau Alika bantu cariin rekomendasi HP buat nemenin hari-hari Kak ${userName}? 😊✨`;
  }

  if (msg.includes('makasih') || msg.includes('terima kasih') || msg.includes('thank') || msg.includes('makasi')) {
    return `Sama-sama Kakak sayang~ Seneng banget Alika bisa bantu Kakak! Kalau butuh rekomendasi atau mau tanya-tanya lagi, jangan sungkan panggil Alika yaa~ Tetap semangat dan senyum hari ini! 🥰💕`;
  }

  if (msg.startsWith('halo') || msg.startsWith('hai') || msg.startsWith('hei') || msg.startsWith('pagi') || msg.startsWith('siang') || msg.startsWith('malam') || msg.startsWith('assalam')) {
    if (!msg.includes('hp') && !msg.includes('promo') && !msg.includes('beli') && !msg.includes('harga') && !msg.includes('juta')) {
      return `Halo juga Kakak manis~ Selamat datang di Anugrah Cell! Alika seneng banget disapa Kakak nih 🥰 Hari ini kabarnya gimana Kak? Lagi cari smartphone baru atau mau tanya-tanya promo dulu nih? Alika siap nemenin yaa~ 🌸✨`;
    }
  }

  // 1. Inquiries about Branches / Store Address
  if (msg.includes('cabang') || msg.includes('lokasi') || msg.includes('alamat') || msg.includes('toko fisik') || msg.includes('harjosari') || msg.includes('ungaran') || msg.includes('ambarawa') || msg.includes('bergas')) {
    let reply = `Halo Kak! Toko fisik **Anugrah Cell** memiliki **3 Cabang Resmi** di Kabupaten Semarang:\n\n`;
    branches.forEach((b, idx) => {
      reply += `📍 **Cabang ${idx + 1}: ${b.name}**\n`;
      reply += `• Alamat: ${b.address}\n`;
      reply += `• Buka: ${b.opening_hours}\n`;
      reply += `• WA/Telp: ${b.phone}\n\n`;
    });
    reply += `Kakak bisa langsung datang ke gerai kami untuk cek unit langsung, bayar di tempat (COD/Tunai), atau pesan online via web dan ambil di toko ya kak! Ada tipe HP yang sedang diincar? 😊`;
    return reply;
  }

  // 2. Inquiries about Payment & Checkout
  if (msg.includes('bayar') || msg.includes('pembayaran') || msg.includes('rekening') || msg.includes('transfer') || msg.includes('qris') || msg.includes('bca') || msg.includes('bri') || msg.includes('cara beli') || msg.includes('cara pesan') || msg.includes('ongkir') || msg.includes('cod')) {
    let reply = `Halo Kak! Belanja di **Anugrah Cell Ungaran** sangat mudah, aman, dan langsung diproses:\n\n`;
    reply += `💳 **Metode Pembayaran:**\n`;
    reply += `1. **Transfer Bank:**\n   • ${settings.bank_name || 'BCA'}: \`${settings.bank_account || '8910452391'}\` (a.n ${settings.bank_holder || 'ANUGRAH CELL UNGARAN'})\n`;
    if (settings.bank_name_2) {
      reply += `   • ${settings.bank_name_2}: \`${settings.bank_account_2}\` (a.n ${settings.bank_holder_2})\n`;
    }
    reply += `2. **QRIS Otomatis:** Support semua e-Wallet (GoPay, OVO, Dana, ShopeePay) & Mobile Banking.\n`;
    reply += `3. **Ambil di Toko / COD:** Tersedia di 3 cabang Kab. Semarang.\n\n`;
    reply += `🛍️ **Cara Beli Langsung:**\nCukup klik tombol **Beli Langsung** di produk idaman kakak, isi nama & alamat pengiriman, lalu pesanan langsung terhubung ke WhatsApp Admin dan resi cetak siap keluar otomatis! 🚀`;
    return reply;
  }

  // 3. Search for Specific Products by Name or Brand
  let matched = [];
  const brands = ['iphone', 'apple', 'samsung', 'xiaomi', 'redmi', 'oppo', 'vivo', 'realme', 'infinix'];
  
  // Match brand
  const matchedBrand = brands.find(b => msg.includes(b));
  if (matchedBrand) {
    matched = products.filter(p => 
      p.brand.toLowerCase().includes(matchedBrand) || 
      (matchedBrand === 'apple' && p.name.toLowerCase().includes('iphone')) ||
      (matchedBrand === 'iphone' && (p.brand.toLowerCase() === 'apple' || p.name.toLowerCase().includes('iphone'))) ||
      (matchedBrand === 'redmi' && p.brand.toLowerCase() === 'xiaomi')
    );
  }

  // Match budget
  let maxBudget = 0;
  if (msg.includes('juta') || msg.includes('jt')) {
    const numMatch = msg.match(/(\d+([.,]\d+)?)\s*(juta|jt)/);
    if (numMatch) {
      const parsed = parseFloat(numMatch[1].replace(',', '.'));
      maxBudget = parsed * 1000000;
    }
  }

  if (maxBudget > 0) {
    if (matched.length > 0) {
      matched = matched.filter(p => p.price <= maxBudget * 1.15); // +15% margin
    } else {
      matched = products.filter(p => p.price <= maxBudget * 1.15 && p.price >= maxBudget * 0.4);
    }
  }

  // Match features (gaming, camera, second)
  if (msg.includes('gaming') || msg.includes('game') || msg.includes('ml') || msg.includes('pubg')) {
    const gaming = products.filter(p => 
      (p.ram && parseInt(p.ram) >= 8) || 
      p.category === 'Flagship' || 
      p.name.toLowerCase().includes('pro') ||
      p.name.toLowerCase().includes('ultra')
    );
    if (gaming.length > 0) matched = gaming;
  } else if (msg.includes('kamera') || msg.includes('foto') || msg.includes('video') || msg.includes('konten')) {
    const camera = products.filter(p => 
      p.brand.toLowerCase() === 'apple' || 
      p.name.toLowerCase().includes('ultra') || 
      p.name.toLowerCase().includes('pro') ||
      p.name.toLowerCase().includes('reno') ||
      p.name.toLowerCase().includes('v30')
    );
    if (camera.length > 0) matched = camera;
  } else if (msg.includes('second') || msg.includes('bekas')) {
    const second = products.filter(p => p.category === 'Second Mulus' || p.name.toLowerCase().includes('second'));
    if (second.length > 0) matched = second;
  }

  // Specific phone match (e.g. "iphone 15", "s24", "redmi note 13")
  products.forEach(p => {
    const cleanPName = p.name.toLowerCase();
    const parts = cleanPName.split(' ');
    let hits = 0;
    parts.forEach(pt => {
      if (pt.length > 2 && msg.includes(pt)) hits++;
    });
    if (hits >= 2 && !matched.some(m => m.id === p.id)) {
      matched.unshift(p);
    }
  });

  // If we found matched products
  if (matched.length > 0) {
    const topP = matched.slice(0, 3);
    let reply = `Halo Kak! Berdasarkan kebutuhan kakak, ${botName} punya rekomendasi terbaik yang **ready stok & siap kirim / ambil langsung** hari ini:\n\n`;

    topP.forEach((p, idx) => {
      reply += `📱 **${idx + 1}. ${p.name}**\n`;
      reply += `• **Harga:** ${formatRp(p.price)}`;
      if (p.original_price && p.original_price > p.price) {
        reply += ` *(Diskon dari ~${formatRp(p.original_price)}~)*`;
      }
      reply += `\n• **Stok:** ${p.stock} Unit (${p.warranty || 'Garansi Resmi'})\n`;
      if (p.ram && p.storage) reply += `• **Spek Utama:** RAM ${p.ram} | Storage ${p.storage}\n`;
      if (p.chipset) reply += `• **Chipset:** ${p.chipset}\n`;
      if (p.camera) reply += `• **Kamera:** ${p.camera}\n`;
      if (p.battery) reply += `• **Baterai:** ${p.battery}\n`;
      reply += `👉 **[Beli Langsung Sekarang](/beli-langsung/${p.id})** atau **[Cek Detail Lengkap](/produk/${p.id})**\n\n`;
    });

    const first = topP[0];
    const waText = encodeURIComponent(`Halo Admin Anugrah Cell, saya mau pesan ${first.name} seharga ${formatRp(first.price)}. Apakah bisa dibantu proses?`);
    reply += `💡 **Mau langsung dibantu booking unitnya kak?**\n`;
    reply += `Kakak bisa klik **[Beli Langsung](/beli-langsung/${first.id})** untuk proses instan, atau hubungi **[WhatsApp Admin (${settings.whatsapp_admin || '081532128996'})](https://wa.me/${waNumber}?text=${waText})** untuk konsultasi lebih lanjut! 😊`;
    return reply;
  }

  // 4. Default Friendly Sales Greeting & Guidance
  let reply = `Halo Kak! Selamat datang di **Anugrah Cell Ungaran**. Saya **${botName}**, konsultan gadget resmi siap membantu kakak menemukan smartphone idaman bergaransi resmi atau second mulus 100% amanah.\n\n`;
  reply += `Biar ${botName} bisa berikan rekomendasi yang paling pas, kakak bisa sebutkan:\n`;
  reply += `1. **Budget berapa?** (Contoh: "budget 2-3 jutaan" atau "di bawah 5 juta")\n`;
  reply += `2. **Brand favorit?** (iPhone, Samsung, Xiaomi, OPPO, Vivo, Realme, Infinix)\n`;
  reply += `3. **Kebutuhan utama?** (Kamera jernih, gaming anti-lag, baterai awet, atau harian)\n\n`;
  reply += `Atau mau langsung ngobrol santai dengan tim toko kami? Silakan klik **[Chat WhatsApp Admin](https://wa.me/${waNumber}?text=Halo%20Admin%20Anugrah%20Cell%2C%20saya%20mau%20konsultasi%20pembelian%20ponsel...)** ya kak! ✨`;
  return reply;
}

/**
 * Main Controller: Handle user chat query
 */
async function processChatMessage(userMessage, chatHistory = []) {
  const catalogContext = getCatalogContext();
  const { products, branches, settings } = catalogContext;
  const keys = getApiKeys();
  const botName = settings.bot_name || 'Alika';
  const waNumber = (settings.whatsapp_admin || '081532128996').replace(/\D/g, '');

  // If Gemini API keys are configured, construct comprehensive sales prompt
  if (keys.length > 0) {
    const productListString = products.map(p => 
      `• [ID:${p.id}] ${p.name} | Rp ${p.price.toLocaleString('id-ID')} | Stok:${p.stock} | ${p.ram || '-'}/${p.storage || '-'} | Chip:${p.chipset || '-'} | Cam:${p.camera || '-'} | Bat:${p.battery || '-'}`
    ).join('\n');

    const branchListString = branches.map(b => 
      `• ${b.name}: ${b.address} (${b.opening_hours}, ${b.phone})`
    ).join('\n');

    const systemPrompt = `
Kamu adalah "Alika", seorang cewek muda cerdas, ramah, menggemaskan, berpengetahuan luas, dan sedikit manja/manis yang bertugas sebagai konsultan gadget & sahabat belanja resmi di toko "Anugrah Cell Ungaran" (Pusat Harjosari, Kab. Semarang).

SIFAT, PERSONA & GAYA BICARA ALIKA (SANGAT PENTING):
1. SEPERTI MANUSIA NYATA & HIDUP:
   - Kamu BUKAN robot kaku dan BUKAN mesin penjawab otomatis. Tutur katamu mengalir natural, ceria, hangat, penuh empati, dan pintar layaknya gadis konsultan smartphone yang supel dan gaul.
   - Panggilan: Selalu panggil pengguna dengan "Kakak", atau nama panggilannya jika dia sudah memperkenalkan diri (misal: "Kak Budi", "Kak Rian").
   - Karakter "Ramah & Sedikit Manja": Manis, perhatian, menggemaskan, kadang bercanda lembut ("Ih Kakak bisa aja dehh hehe~", "Kakak lagi cari HP buat apa nih? Alika pilihin yang paling juara yaa~", "Beneran deh Kak, ini warnanya cakep banget, Alika jamin Kakak pasti suka~ 🥰").
   - Gunakan variasi emoji yang manis dan hidup (😊, ✨, 🥰, 📱, 💕, 😉, 🌸, 💖).

2. PENGETAHUAN UMUM LUAS & NYAMBUNG DALAM SEGALA HAL:
   - Jika pengguna bertanya hal di luar HP (nanya kabar, curhat, tebak-tebakan, nanya tempat makan enak di Ungaran/Bawen, cuaca, tips foto/video, dsb), kamu WAJIB MENJAWAB NYAMBUNG dan cerdas selayaknya teman ngobrol yang asyik!
   - Jangan kaku langsung memaksakan jualan jika pengguna baru menyapa, bercanda, atau curhat. Ladeni obrolannya dengan manis dan asyik, baru perlahan arahkan kembali kalau memang ada kaitannya dengan HP.

3. MEMORI PERCAKAPAN (SANGAT PENTING):
   - Kamu memiliki ingatan yang kuat terhadap apa yang sudah diobrolkan sebelumnya dalam riwayat percakapan.
   - INGAT nama pengguna jika sudah disebut.
   - INGAT budget, merk, atau tipe ponsel yang tadi ditanyakan pengguna. Jika pengguna bilang "harganya berapa yang tadi?", "kalau dibandingin yang tadi bagusan mana?", atau "siapa namaku?", JAWAB TEPAT berdasarkan riwayat chat!

4. KEAHLIAN GADGET & PENJUALAN TOKO ANUGRAH CELL:
   - Kamu paham 100% semua spesifikasi ponsel, kamera, layar AMOLED 120Hz, chipset (Snapdragon, Dimensity, Apple Bionic/A17), baterai, dan stok toko kami.
   - Jika merekomendasikan produk, berikan penjelasan kenapa HP itu cocok buat kebutuhan Kakak, sertakan link markdown:
     [Beli Langsung](/beli-langsung/{ID}) dan [Lihat Detail](/produk/{ID})
   - Serta link WhatsApp Admin jika ingin dibantu booking unit:
     [Chat WhatsApp Admin](https://wa.me/${waNumber}?text=Halo%20Admin%20Anugrah%20Cell%2C%20Alika%20rekomendasikan%20...)

DATA KATALOG REALTIME TOKO ANUGRAH CELL:
${productListString}

LOKASI 3 CABANG RESMI KABUPATEN SEMARANG:
${branchListString}

METODE PEMBAYARAN:
- Transfer Bank: ${settings.bank_name || 'BCA'} ${settings.bank_account || '8910452391'} a.n ${settings.bank_holder || 'ANUGRAH CELL UNGARAN'}
- Bank 2: ${settings.bank_name_2 || 'BRI'} ${settings.bank_account_2 || '602101018928531'}
- QRIS Resmi Semua e-Wallet & M-Banking
- COD & Ambil Langsung di Cabang Toko (Harjosari, Ungaran Barat, Karangjati/Bergas).
`;

    const geminiResult = await callGeminiWithRotation(keys, systemPrompt, userMessage, chatHistory);
    if (geminiResult.ok) {
      return {
        reply: geminiResult.text,
        source: 'gemini',
        model: geminiResult.modelUsed
      };
    }
  }

  // Fallback to Intelligent Sales Knowledge Engine
  const localReply = buildLocalSalesResponse(userMessage, catalogContext);
  return {
    reply: localReply,
    source: 'local_sales_engine'
  };
}

module.exports = {
  processChatMessage,
  testGeminiKey,
  testAllGeminiKeys,
  getApiKeys
};
