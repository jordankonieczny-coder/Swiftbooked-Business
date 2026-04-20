(function () {
  const script = document.currentScript || document.querySelector('script[data-key]');
  const KEY = script && script.getAttribute('data-key');
  if (!KEY) return;

  const BASE = (function () {
    try {
      const src = script.src || '';
      const url = new URL(src);
      return url.origin;
    } catch (_) {
      return 'https://swiftbooked.ca';
    }
  })();

  const SESSION_KEY = 'sb_sid_' + KEY;
  let sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = 'w_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  let bizName = 'AI Assistant';
  let isOpen = false;
  let isTyping = false;

  // ── Styles ──────────────────────────────────────────────────────────────────
  const css = `
    #sb-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 99998;
      width: 58px; height: 58px; border-radius: 50%;
      background: #1a56db; color: #fff; border: none; cursor: pointer;
      box-shadow: 0 4px 16px rgba(26,86,219,0.45);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s, background 0.2s;
      font-size: 1.5rem; line-height: 1;
    }
    #sb-btn:hover { background: #1342a8; transform: scale(1.07); }
    #sb-panel {
      position: fixed; bottom: 94px; right: 24px; z-index: 99999;
      width: 340px; height: 480px; border-radius: 16px;
      background: #fff; box-shadow: 0 8px 40px rgba(0,0,0,0.18);
      display: flex; flex-direction: column; overflow: hidden;
      transform: scale(0.92) translateY(16px); opacity: 0;
      pointer-events: none;
      transition: transform 0.2s ease, opacity 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      font-size: 14px;
    }
    #sb-panel.sb-open {
      transform: scale(1) translateY(0); opacity: 1; pointer-events: auto;
    }
    #sb-header {
      background: #1a56db; color: #fff;
      padding: 14px 16px; display: flex; align-items: center; gap: 10px;
      flex-shrink: 0;
    }
    #sb-avatar {
      width: 32px; height: 32px; border-radius: 50%;
      background: rgba(255,255,255,0.25);
      display: flex; align-items: center; justify-content: center;
      font-size: 1rem; flex-shrink: 0;
    }
    #sb-title { flex: 1; }
    #sb-title strong { display: block; font-size: 0.9rem; font-weight: 700; }
    #sb-title span { font-size: 0.75rem; opacity: 0.8; }
    #sb-close {
      background: none; border: none; color: rgba(255,255,255,0.8);
      cursor: pointer; font-size: 1.2rem; line-height: 1; padding: 4px;
    }
    #sb-close:hover { color: #fff; }
    #sb-messages {
      flex: 1; overflow-y: auto; padding: 14px 14px 6px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .sb-msg { display: flex; flex-direction: column; max-width: 82%; }
    .sb-msg.sb-user { align-self: flex-end; align-items: flex-end; }
    .sb-msg.sb-bot { align-self: flex-start; }
    .sb-bubble {
      padding: 9px 13px; border-radius: 14px;
      font-size: 0.88rem; line-height: 1.5; word-break: break-word;
    }
    .sb-user .sb-bubble { background: #1a56db; color: #fff; border-bottom-right-radius: 4px; }
    .sb-bot .sb-bubble { background: #f0f2f5; color: #111; border-bottom-left-radius: 4px; }
    .sb-typing .sb-bubble { display: flex; gap: 4px; align-items: center; padding: 12px 16px; }
    .sb-dot {
      width: 7px; height: 7px; border-radius: 50%; background: #9ca3af;
      animation: sb-bounce 1.2s infinite ease-in-out;
    }
    .sb-dot:nth-child(2) { animation-delay: 0.2s; }
    .sb-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes sb-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-5px); }
    }
    #sb-footer {
      padding: 10px 12px; border-top: 1px solid #f0f2f5;
      display: flex; gap: 8px; flex-shrink: 0; background: #fff;
    }
    #sb-input {
      flex: 1; padding: 9px 12px; border: 1.5px solid #e5e7eb; border-radius: 10px;
      font-size: 0.88rem; font-family: inherit; outline: none;
      transition: border-color 0.15s; resize: none; max-height: 90px; overflow-y: auto;
    }
    #sb-input:focus { border-color: #1a56db; }
    #sb-send {
      background: #1a56db; color: #fff; border: none; border-radius: 10px;
      padding: 0 14px; cursor: pointer; font-size: 1rem; flex-shrink: 0;
      transition: background 0.15s;
    }
    #sb-send:hover { background: #1342a8; }
    #sb-send:disabled { opacity: 0.5; cursor: not-allowed; }
    #sb-powered {
      text-align: center; padding: 4px 0 8px;
      font-size: 0.7rem; color: #d1d5db; flex-shrink: 0;
    }
    #sb-powered a { color: #d1d5db; text-decoration: none; }
    #sb-powered a:hover { color: #9ca3af; }
    @media (max-width: 480px) {
      #sb-panel { width: calc(100vw - 16px); right: 8px; bottom: 82px; height: 420px; }
      #sb-btn { bottom: 16px; right: 16px; }
    }
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── DOM ──────────────────────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.id = 'sb-btn';
  btn.setAttribute('aria-label', 'Open chat');
  btn.innerHTML = '💬';

  const panel = document.createElement('div');
  panel.id = 'sb-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Chat with us');
  panel.innerHTML = `
    <div id="sb-header">
      <div id="sb-avatar">🤖</div>
      <div id="sb-title">
        <strong id="sb-biz-name">Loading…</strong>
        <span>AI Assistant · Typically replies instantly</span>
      </div>
      <button id="sb-close" aria-label="Close chat">✕</button>
    </div>
    <div id="sb-messages"></div>
    <div id="sb-footer">
      <textarea id="sb-input" placeholder="Type a message…" rows="1"></textarea>
      <button id="sb-send">➤</button>
    </div>
    <div id="sb-powered"><a href="https://swiftbooked.ca" target="_blank" rel="noopener">Powered by Swiftbooked</a></div>
  `;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  // ── Logic ────────────────────────────────────────────────────────────────────
  const messagesEl = document.getElementById('sb-messages');
  const inputEl    = document.getElementById('sb-input');
  const sendEl     = document.getElementById('sb-send');
  const bizNameEl  = document.getElementById('sb-biz-name');

  function addMessage(role, text) {
    const wrap = document.createElement('div');
    wrap.className = 'sb-msg ' + (role === 'user' ? 'sb-user' : 'sb-bot');
    const bubble = document.createElement('div');
    bubble.className = 'sb-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  function showTyping() {
    const wrap = document.createElement('div');
    wrap.className = 'sb-msg sb-bot sb-typing';
    wrap.innerHTML = '<div class="sb-bubble"><div class="sb-dot"></div><div class="sb-dot"></div><div class="sb-dot"></div></div>';
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  async function loadConfig() {
    try {
      const res = await fetch(`${BASE}/api/widget/config?key=${KEY}`);
      if (!res.ok) return;
      const data = await res.json();
      bizName = data.business_name || 'AI Assistant';
      bizNameEl.textContent = bizName;
      if (!messagesEl.children.length) {
        addMessage('bot', `Hi! I'm the ${bizName} virtual assistant. How can I help you today?`);
      }
    } catch (_) {
      bizNameEl.textContent = 'AI Assistant';
    }
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isTyping) return;
    inputEl.value = '';
    inputEl.style.height = '';
    addMessage('user', text);
    isTyping = true;
    sendEl.disabled = true;
    const typingEl = showTyping();
    try {
      const res = await fetch(`${BASE}/api/widget/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: KEY, sessionId, message: text }),
      });
      const data = await res.json();
      typingEl.remove();
      addMessage('bot', data.reply || 'Sorry, something went wrong. Please try again.');
    } catch (_) {
      typingEl.remove();
      addMessage('bot', 'Sorry, I\'m having trouble connecting. Please call us directly.');
    } finally {
      isTyping = false;
      sendEl.disabled = false;
      inputEl.focus();
    }
  }

  btn.addEventListener('click', function () {
    isOpen = !isOpen;
    btn.innerHTML = isOpen ? '✕' : '💬';
    panel.classList.toggle('sb-open', isOpen);
    if (isOpen) {
      if (!messagesEl.children.length) loadConfig();
      inputEl.focus();
    }
  });

  document.getElementById('sb-close').addEventListener('click', function () {
    isOpen = false;
    btn.innerHTML = '💬';
    panel.classList.remove('sb-open');
  });

  sendEl.addEventListener('click', sendMessage);

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 90) + 'px';
  });
})();
