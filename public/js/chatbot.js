/**
 * Anugrah Cell - Gemini AI Sales Chatbot & Draggable Floating Button
 */

(function () {
  const fab = document.getElementById('chatbot-fab');
  const overlay = document.getElementById('chatbot-modal');
  const closeBtn = document.getElementById('chatbot-close-btn');
  const form = document.getElementById('chatbot-form');
  const input = document.getElementById('chatbot-input');
  const messagesBox = document.getElementById('chatbot-messages');
  const chips = document.querySelectorAll('.chat-chip');

  if (!fab || !overlay) return;

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;
  let hasMoved = false;

  // Multi-turn Conversation Memory (persisted in sessionStorage)
  let chatHistory = [];
  try {
    const savedChat = JSON.parse(sessionStorage.getItem('alika_chat_history') || '[]');
    if (Array.isArray(savedChat)) {
      chatHistory = savedChat;
    }
  } catch (e) {
    chatHistory = [];
  }

  // Restore saved chat history to UI if any
  if (chatHistory.length > 0 && messagesBox) {
    chatHistory.forEach(item => {
      if (item.sender === 'user' && item.text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-msg chat-msg-user';
        msgDiv.innerHTML = `<div class="chat-bubble">${item.text}</div>`;
        messagesBox.appendChild(msgDiv);
      } else if (item.sender === 'bot' && item.text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-msg chat-msg-bot';
        msgDiv.innerHTML = `<div class="chat-bubble">${parseMarkdown(item.text)}</div>`;
        messagesBox.appendChild(msgDiv);
      }
    });
  }

  // ========================================================
  // 1. DRAGGABLE FLOATING BUTTON (TOUCH & MOUSE SUPPORT)
  // ========================================================

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // Restore saved position if valid
  try {
    const savedPos = JSON.parse(localStorage.getItem('alika_fab_pos') || localStorage.getItem('anin_fab_pos') || 'null');
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      const maxX = window.innerWidth - fab.offsetWidth - 10;
      const maxY = window.innerHeight - fab.offsetHeight - 10;
      fab.style.left = clamp(savedPos.left, 10, maxX) + 'px';
      fab.style.top = clamp(savedPos.top, 10, maxY) + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    }
  } catch (e) {}

  function onDragStart(clientX, clientY) {
    isDragging = true;
    hasMoved = false;
    startX = clientX;
    startY = clientY;

    const rect = fab.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    fab.classList.add('is-dragging');
  }

  function onDragMove(clientX, clientY) {
    if (!isDragging) return;

    const dx = clientX - startX;
    const dy = clientY - startY;

    if (Math.hypot(dx, dy) > 5) {
      hasMoved = true;
    }

    if (hasMoved) {
      const maxX = window.innerWidth - fab.offsetWidth - 8;
      const maxY = window.innerHeight - fab.offsetHeight - 8;

      const newLeft = clamp(initialLeft + dx, 8, maxX);
      const newTop = clamp(initialTop + dy, 8, maxY);

      fab.style.left = newLeft + 'px';
      fab.style.top = newTop + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    }
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    fab.classList.remove('is-dragging');

    if (hasMoved) {
      // Save position to localStorage
      try {
        const rect = fab.getBoundingClientRect();
        localStorage.setItem('alika_fab_pos', JSON.stringify({ left: rect.left, top: rect.top }));
      } catch (e) {}
    } else {
      // It was a tap/click!
      openChat();
    }
  }

  // Mouse Listeners
  fab.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return; // Left click only
    onDragStart(e.clientX, e.clientY);

    function mouseMoveHandler(ev) {
      onDragMove(ev.clientX, ev.clientY);
    }

    function mouseUpHandler() {
      window.removeEventListener('mousemove', mouseMoveHandler);
      window.removeEventListener('mouseup', mouseUpHandler);
      onDragEnd();
    }

    window.addEventListener('mousemove', mouseMoveHandler);
    window.addEventListener('mouseup', mouseUpHandler);
  });

  // Touch Listeners
  fab.addEventListener('touchstart', function (e) {
    const touch = e.touches[0];
    onDragStart(touch.clientX, touch.clientY);
  }, { passive: true });

  window.addEventListener('touchmove', function (e) {
    if (!isDragging) return;
    const touch = e.touches[0];
    onDragMove(touch.clientX, touch.clientY);
  }, { passive: true });

  window.addEventListener('touchend', function () {
    if (isDragging) {
      onDragEnd();
    }
  });

  // ========================================================
  // 2. MODAL TOGGLE
  // ========================================================

  function openChat() {
    overlay.classList.add('active');
    setTimeout(() => {
      input.focus();
      scrollChatBottom();
    }, 150);
  }

  function closeChat() {
    overlay.classList.remove('active');
  }

  closeBtn.addEventListener('click', closeChat);

  // Close when tapping outside the modal window
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) {
      closeChat();
    }
  });

  // ESC key to close
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.classList.contains('active')) {
      closeChat();
    }
  });

  // ========================================================
  // 3. MESSAGING & GEMINI AI INTEGRATION
  // ========================================================

  function scrollChatBottom() {
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }

  // Simple Markdown parser for bold, links, and lines
  function parseMarkdown(text) {
    if (!text) return '';
    
    // Escape HTML first
    let escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Bold **text**
    escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Strikethrough ~text~
    escaped = escaped.replace(/~(.*?)~/g, '<del>$1</del>');

    // Inline Code `text`
    escaped = escaped.replace(/`(.*?)`/g, '<code style="background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:0.85em;">$1</code>');

    // Markdown Links [Text](URL)
    escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(match, label, url) {
      if (url.includes('/beli-langsung/')) {
        return `<a href="${url}" class="chat-btn-direct-buy"><i class="bi bi-lightning-charge-fill"></i> ${label}</a>`;
      } else if (url.includes('wa.me')) {
        return `<a href="${url}" target="_blank" class="chat-btn-wa-deal"><i class="bi bi-whatsapp"></i> ${label}</a>`;
      }
      return `<a href="${url}">${label}</a>`;
    });

    // Newlines to <br> or paragraphs
    const paragraphs = escaped.split('\n\n').map(p => {
      const lines = p.split('\n').join('<br>');
      return `<p>${lines}</p>`;
    });

    return paragraphs.join('');
  }

  function appendUserMessage(text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg chat-msg-user';
    msgDiv.innerHTML = `<div class="chat-bubble">${text}</div>`;
    messagesBox.appendChild(msgDiv);
    scrollChatBottom();
  }

  function appendBotMessage(text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg chat-msg-bot';
    msgDiv.innerHTML = `<div class="chat-bubble">${parseMarkdown(text)}</div>`;
    messagesBox.appendChild(msgDiv);
    scrollChatBottom();
  }

  function showTypingIndicator() {
    const indDiv = document.createElement('div');
    indDiv.id = 'chat-typing-loader';
    indDiv.className = 'chat-typing-indicator';
    indDiv.innerHTML = `
      <span style="font-size: 0.72rem; color: #64748b; font-weight: 600; margin-right: 4px;">Alika mengetik</span>
      <div class="chat-typing-dot"></div>
      <div class="chat-typing-dot"></div>
      <div class="chat-typing-dot"></div>
    `;
    messagesBox.appendChild(indDiv);
    scrollChatBottom();
  }

  function removeTypingIndicator() {
    const el = document.getElementById('chat-typing-loader');
    if (el) el.remove();
  }

  async function sendMessage(text) {
    if (!text || !text.trim()) return;
    const cleanText = text.trim();

    appendUserMessage(cleanText);
    chatHistory.push({ sender: 'user', text: cleanText });
    try {
      sessionStorage.setItem('alika_chat_history', JSON.stringify(chatHistory.slice(-20)));
    } catch (e) {}

    input.value = '';
    input.disabled = true;
    showTypingIndicator();

    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), 12000); // 12s timeout for thoughtful AI responses

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        signal: abortCtrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: cleanText, history: chatHistory.slice(-10) })
      });
      clearTimeout(timeoutId);

      const data = await response.json();
      removeTypingIndicator();

      if (data && data.reply) {
        appendBotMessage(data.reply);
        chatHistory.push({ sender: 'bot', text: data.reply });
        try {
          sessionStorage.setItem('alika_chat_history', JSON.stringify(chatHistory.slice(-20)));
        } catch (e) {}
      } else {
        appendBotMessage('Halo Kak! Alika siap bantu. Ada kendala sedikit, silakan coba kirim lagi atau langsung klik [WhatsApp Admin Toko (0815-3212-8996)](https://wa.me/6281532128996) ya!');
      }
    } catch (err) {
      clearTimeout(timeoutId);
      removeTypingIndicator();
      if (err.name === 'AbortError') {
        appendBotMessage('Jaringan agak padat nih Kak~ Kakak bisa langsung klik [WhatsApp Admin Toko (0815-3212-8996)](https://wa.me/6281532128996) biar langsung Alika temenin via WhatsApp ya! 🥰');
      } else {
        appendBotMessage('Koneksi terputus. Silakan klik [Chat WhatsApp Admin (0815-3212-8996)](https://wa.me/6281532128996) untuk respon cepat.');
      }
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  // Form submit listener
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    sendMessage(input.value);
  });

  // Quick Chips click
  chips.forEach(chip => {
    chip.addEventListener('click', function () {
      const query = this.getAttribute('data-query') || this.innerText;
      sendMessage(query);
    });
  });

  // Expose helper globally
  window.openAlikaChat = window.openAninChat = function (initialMsg) {
    openChat();
    if (initialMsg) {
      setTimeout(() => sendMessage(initialMsg), 300);
    }
  };
})();
