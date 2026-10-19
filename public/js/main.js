// Anugrah Cell Ungaran - Client Script with Real-Time Parallel Sync

function showToast(message, type = 'success') {
  let toast = document.getElementById('global-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'global-toast';
    toast.style.position = 'fixed';
    toast.style.top = '16px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.padding = '10px 20px';
    toast.style.borderRadius = '9999px';
    toast.style.zIndex = '999999';
    toast.style.fontWeight = '700';
    toast.style.fontSize = '0.85rem';
    toast.style.boxShadow = '0 8px 24px rgba(0,0,0,0.15)';
    toast.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
    document.body.appendChild(toast);
  }

  if (type === 'success') {
    toast.style.background = '#10b981';
    toast.style.color = '#fff';
    toast.innerHTML = `<i class="bi bi-check-circle-fill"></i> ${message}`;
  } else if (type === 'info') {
    toast.style.background = '#2563eb';
    toast.style.color = '#fff';
    toast.innerHTML = `<i class="bi bi-arrow-repeat"></i> ${message}`;
  } else {
    toast.style.background = '#ef4444';
    toast.style.color = '#fff';
    toast.innerHTML = `<i class="bi bi-exclamation-circle-fill"></i> ${message}`;
  }

  toast.style.opacity = '1';
  toast.style.visibility = 'visible';

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.visibility = 'hidden';
  }, 3500);
}

// Copy to clipboard helper
function copyToClipboard(text, label) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(`${label || 'Teks'} berhasil disalin ke clipboard!`);
  }).catch(err => {
    console.error('Failed to copy', err);
  });
}

// Add to Cart via Fetch
async function addToCart(productId, quantity = 1) {
  try {
    const response = await fetch('/cart/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ productId, quantity })
    });
    const data = await response.json();
    if (data.success) {
      showToast('Ponsel ditambahkan ke Keranjang!');
      const badges = document.querySelectorAll('.cart-badge-bubble, .cart-badge');
      badges.forEach(b => {
        b.textContent = data.cartCount;
      });
    } else {
      showToast(data.message || 'Gagal menambahkan produk', 'error');
    }
  } catch (error) {
    console.error('Error adding to cart:', error);
    window.location.href = `/cart`;
  }
}

// Quick Price Update (Admin)
async function updateProductPrice(productId, newPrice, origPrice) {
  try {
    const res = await fetch(`/admin/produk/quick-price/${productId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ price: newPrice, original_price: origPrice })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Harga berhasil diubah menjadi ${new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(data.price)}!`);
    }
  } catch (err) {
    console.error('Failed to update price:', err);
  }
}

// ==========================================
// REAL-TIME PARALLEL SYNC (SSE)
// ==========================================
function initRealtimeLiveSync() {
  if (!window.EventSource) return;

  const eventSource = new EventSource('/api/live-sync');

  eventSource.onopen = function() {
    console.log('⚡ Connected to Anugrah Cell Live Real-Time Stream');
  };

  eventSource.onmessage = function(e) {
    try {
      const event = JSON.parse(e.data);

      if (event.type === 'product_changed') {
        showToast('⚡ Katalog atau harga ponsel baru saja diperbarui! Menyinkronkan...', 'info');
        // If on homepage or catalog, reload data smoothly after short delay
        if (window.location.pathname === '/' || window.location.pathname === '/katalog' || window.location.pathname.startsWith('/produk/')) {
          setTimeout(() => {
            window.location.reload();
          }, 800);
        }
      }

      if (event.type === 'settings_changed' || event.type === 'branch_changed') {
        showToast('⚡ Alamat cabang / kontak toko baru saja diperbarui!', 'info');
        setTimeout(() => {
          window.location.reload();
        }, 800);
      }

      if (event.type === 'order_placed') {
        // If admin is viewing dashboard or orders, refresh
        if (window.location.pathname.startsWith('/admin')) {
          showToast(`🔔 Pesanan baru masuk! ID: ${event.data.orderId}`, 'info');
          setTimeout(() => {
            window.location.reload();
          }, 1000);
        }
      }

      if (event.type === 'order_status_updated') {
        // If customer is on my-orders or admin is on orders
        if (window.location.pathname === '/pesanan-saya' || window.location.pathname === '/admin/pesanan') {
          showToast('⚡ Status pesanan / resi telah diperbarui!', 'info');
          setTimeout(() => {
            window.location.reload();
          }, 800);
        }
      }

    } catch (err) {
      // not JSON (heartbeat)
    }
  };

  eventSource.onerror = function() {
    // SSE will automatically attempt reconnection
  };
}

// ==========================================
// 1-CLICK PWA MOBILE APP INSTALLER
// ==========================================
let deferredPwaPrompt = null;

function isRunningStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

// Register Service Worker for 1-Click Android WebAPK & PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registration:', err);
    });
  });
}

// Capture native 1-click install prompt from Chrome/Android/Edge/Samsung
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPwaPrompt = e;
  updatePwaVisibility();
});

// Detect successful app installation
window.addEventListener('appinstalled', () => {
  deferredPwaPrompt = null;
  sessionStorage.setItem('pwa_installed', '1');
  hideAllPwaButtons();
  closePwaModal();
  showToast('🎉 Aplikasi Anugrah Cell berhasil diinstal di HP Anda!');
});

function hideAllPwaButtons() {
  const banner = document.getElementById('pwaInstallBanner');
  const headerBtn = document.getElementById('headerInstallBtn');
  const footerBtn = document.getElementById('footerInstallBtn');
  if (banner) banner.style.display = 'none';
  if (headerBtn) headerBtn.style.display = 'none';
  if (footerBtn) footerBtn.style.display = 'none';
}

function dismissPwaBanner() {
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.style.display = 'none';
  sessionStorage.setItem('pwa_banner_dismissed', '1');
}

function updatePwaVisibility() {
  if (isRunningStandalone() || sessionStorage.getItem('pwa_installed') === '1') {
    hideAllPwaButtons();
    return;
  }
  const banner = document.getElementById('pwaInstallBanner');
  if (banner && sessionStorage.getItem('pwa_banner_dismissed') === '1') {
    banner.style.display = 'none';
  }
}

async function triggerPwaInstall() {
  // 1. If native 1-click prompt is ready, trigger it immediately!
  if (deferredPwaPrompt) {
    try {
      deferredPwaPrompt.prompt();
      const { outcome } = await deferredPwaPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredPwaPrompt = null;
        showToast('📲 Menginstal Aplikasi Anugrah Cell ke Layar Utama...');
        hideAllPwaButtons();
      }
      return;
    } catch (err) {
      console.warn('Prompt error:', err);
    }
  }

  // 2. If on iOS Safari or browser where native prompt requires 1 tap from browser bar
  openPwaModal();
}

function openPwaModal() {
  const modal = document.getElementById('pwaInstallModal');
  const stepsEl = document.getElementById('pwaModalSteps');
  if (!modal || !stepsEl) return;

  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;

  if (isIOS) {
    stepsEl.innerHTML = `
      <div class="pwa-step-item">
        <span class="pwa-step-num">1</span>
        <div>Ketuk ikon <strong>Bagikan (Share)</strong> <i class="bi bi-box-arrow-up" style="color:#0284c7;"></i> di bagian bawah browser Safari Anda.</div>
      </div>
      <div class="pwa-step-item">
        <span class="pwa-step-num">2</span>
        <div>Pilih menu <strong>"Tambah ke Layar Utama"</strong> <em>(Add to Home Screen)</em> <i class="bi bi-plus-square" style="color:#0284c7;"></i> lalu ketuk <strong>Tambah</strong>.</div>
      </div>
    `;
  } else {
    stepsEl.innerHTML = `
      <div class="pwa-step-item">
        <span class="pwa-step-num">1</span>
        <div>Ketuk ikon menu <strong>Titik Tiga (&#8942;)</strong> di pojok kanan atas browser Chrome Anda.</div>
      </div>
      <div class="pwa-step-item">
        <span class="pwa-step-num">2</span>
        <div>Ketuk <strong>"Instal aplikasi"</strong> atau <strong>"Tambahkan ke Layar utama"</strong> <i class="bi bi-phone-fill" style="color:#0284c7;"></i> untuk langsung menginstal!</div>
      </div>
    `;
  }

  modal.classList.add('active');
}

function closePwaModal() {
  const modal = document.getElementById('pwaInstallModal');
  if (modal) modal.classList.remove('active');
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initRealtimeLiveSync();
  updatePwaVisibility();
});

