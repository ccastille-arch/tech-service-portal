'use strict';

// ===================== AI BUTTONS =====================
const btnAiCategory = document.getElementById('btn-ai-category');
const btnAiPriority = document.getElementById('btn-ai-priority');
const categoryResult = document.getElementById('ai-category-result');
const priorityResult = document.getElementById('ai-priority-result');
const categorySelect = document.getElementById('category-select');
const prioritySelect = document.getElementById('priority-select');
const descArea = document.getElementById('ticket-description');
const titleInput = document.getElementById('ticket-title');

if (btnAiCategory) {
  btnAiCategory.addEventListener('click', async () => {
    const description = descArea ? descArea.value : '';
    if (!description.trim()) { alert('Enter a description first.'); return; }
    btnAiCategory.disabled = true;
    btnAiCategory.textContent = '⏳ Analyzing…';
    try {
      const r = await fetch('/api/ai/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken || '' },
        body: JSON.stringify({ description })
      });
      const data = await r.json();
      if (categoryResult) {
        categoryResult.classList.remove('hidden');
        categoryResult.innerHTML = `
          <div class="ai-label">🤖 AI Category Suggestion</div>
          <div class="ai-value">${data.category}</div>
          <div class="ai-reasoning">${data.reasoning}</div>
          <button type="button" class="btn btn-secondary btn-sm" style="margin-top:.5rem;"
            onclick="document.getElementById('category-select').value='${data.category}';this.parentElement.classList.add('hidden');">
            Apply
          </button>`;
      }
      if (categorySelect && data.category) categorySelect.value = data.category;
    } catch(e) { console.error(e); }
    btnAiCategory.disabled = false;
    btnAiCategory.textContent = '🤖 Auto-Categorize';
  });
}

if (btnAiPriority) {
  btnAiPriority.addEventListener('click', async () => {
    const title = titleInput ? titleInput.value : '';
    const description = descArea ? descArea.value : '';
    if (!title.trim()) { alert('Enter a title first.'); return; }
    btnAiPriority.disabled = true;
    btnAiPriority.textContent = '⏳ Analyzing…';
    try {
      const r = await fetch('/api/ai/suggest-priority', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken || '' },
        body: JSON.stringify({ title, description })
      });
      const data = await r.json();
      if (priorityResult) {
        priorityResult.classList.remove('hidden');
        priorityResult.innerHTML = `
          <div class="ai-label">🤖 AI Priority Suggestion</div>
          <div class="ai-value">${data.priority}</div>
          <div class="ai-reasoning">${data.reasoning}</div>
          <button type="button" class="btn btn-secondary btn-sm" style="margin-top:.5rem;"
            onclick="document.getElementById('priority-select').value='${data.priority}';this.parentElement.classList.add('hidden');">
            Apply
          </button>`;
      }
      if (prioritySelect && data.priority) prioritySelect.value = data.priority;
    } catch(e) { console.error(e); }
    btnAiPriority.disabled = false;
    btnAiPriority.textContent = '🤖 Suggest Priority';
  });
}

// Auto-update due date when priority changes
if (prioritySelect) {
  const SLA_HOURS = { P1: 4, P2: 24, P3: 72, P4: 168 };
  const dueDateInput = document.querySelector('input[name="due_date"]');
  prioritySelect.addEventListener('change', () => {
    if (!dueDateInput) return;
    const hours = SLA_HOURS[prioritySelect.value] || 72;
    const d = new Date();
    d.setHours(d.getHours() + hours);
    dueDateInput.value = d.toISOString().slice(0, 16);
  });
}
