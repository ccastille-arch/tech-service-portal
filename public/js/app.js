'use strict';

// ===================== SIDEBAR TOGGLE =====================
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (sidebar) sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('open');
}

// ===================== TABS =====================
function switchTab(btn, panelId) {
  // Deactivate all tabs and panels in same group
  const tabs = btn.closest('.tabs');
  if (tabs) tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const content = tabs ? tabs.nextElementSibling : null;
  if (content) {
    const panels = content.parentElement.querySelectorAll('.tab-panel');
    panels.forEach(p => p.classList.remove('active'));
  }
  // Activate clicked
  btn.classList.add('active');
  const panel = document.getElementById(panelId);
  if (panel) panel.classList.add('active');
}

// ===================== MODAL =====================
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('open');
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('open');
}
// Close modal on overlay click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
});

// ===================== AUTO-DISMISS FLASH =====================
const flashMsg = document.getElementById('flash-msg');
if (flashMsg) {
  setTimeout(() => {
    flashMsg.style.transition = 'opacity .4s';
    flashMsg.style.opacity = '0';
    setTimeout(() => flashMsg.remove(), 400);
  }, 5000);
}

// ===================== LOCAL TIMESTAMPS =====================
// All timestamps stored and rendered as UTC ISO strings.
// This runs client-side so they display in the user's local timezone.
function convertTimestamps() {
  document.querySelectorAll('[data-ts]').forEach(el => {
    const raw = el.getAttribute('data-ts');
    if (!raw) return;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return;
    const mode = el.getAttribute('data-ts-fmt') || 'datetime';
    if (mode === 'date') {
      el.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } else if (mode === 'short') {
      el.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } else {
      el.textContent = d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
  });
}
document.addEventListener('DOMContentLoaded', convertTimestamps);

// ===================== LIVE TIMER =====================
const liveTimer = document.getElementById('live-timer');
if (liveTimer) {
  const startTime = new Date(liveTimer.dataset.start);
  function updateTimer() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
    const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    liveTimer.textContent = `${h}:${m}:${s}`;
  }
  updateTimer();
  setInterval(updateTimer, 1000);
}
