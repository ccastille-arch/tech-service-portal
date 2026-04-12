'use strict';

const CHART_DEFAULTS = {
  backgroundColor: 'transparent',
  color: '#c8d8e8',
  borderColor: 'rgba(0,200,232,.15)',
};

Chart.defaults.color = '#c8d8e8';
Chart.defaults.borderColor = 'rgba(0,200,232,.1)';
Chart.defaults.font.family = 'Rajdhani, sans-serif';
Chart.defaults.font.size = 13;

const COLORS = {
  primary: '#ff6b00',
  secondary: '#00c8e8',
  success: '#00d4a0',
  danger: '#ff3355',
  warning: '#ffd60a',
  muted: '#4a6080',
  P1: '#ff3355', P2: '#ffd60a', P3: '#00c8e8', P4: '#4a6080'
};

let charts = {};

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

async function loadCharts() {
  const range = document.getElementById('range-select')?.value || 30;
  const res = await fetch(`/api/reports/data?range=${range}`);
  const data = await res.json();

  // 1. Open vs Closed line chart
  destroyChart('daily');
  const ctxDaily = document.getElementById('chart-daily');
  if (ctxDaily) {
    charts.daily = new Chart(ctxDaily, {
      type: 'line',
      data: {
        labels: data.dailyCounts.map(d => d.date),
        datasets: [
          {
            label: 'Open',
            data: data.dailyCounts.map(d => d.open),
            borderColor: COLORS.secondary,
            backgroundColor: 'rgba(0,200,232,.08)',
            tension: .3, fill: true
          },
          {
            label: 'Closed',
            data: data.dailyCounts.map(d => d.closed),
            borderColor: COLORS.success,
            backgroundColor: 'rgba(0,212,160,.08)',
            tension: .3, fill: true
          }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: 'top' } } }
    });
  }

  // 2. By Priority bar
  destroyChart('priority');
  const ctxPri = document.getElementById('chart-priority');
  if (ctxPri) {
    charts.priority = new Chart(ctxPri, {
      type: 'bar',
      data: {
        labels: data.byPriority.map(d => d.priority),
        datasets: [{
          data: data.byPriority.map(d => d.cnt),
          backgroundColor: data.byPriority.map(d => COLORS[d.priority] || COLORS.muted),
          borderRadius: 4
        }]
      },
      options: { responsive: true, plugins: { legend: { display: false } }, indexAxis: 'x' }
    });
  }

  // 3. Tickets per tech donut
  destroyChart('tech');
  const ctxTech = document.getElementById('chart-tech');
  if (ctxTech) {
    charts.tech = new Chart(ctxTech, {
      type: 'doughnut',
      data: {
        labels: data.ticketsPerTech.map(d => d.name),
        datasets: [{
          data: data.ticketsPerTech.map(d => d.cnt),
          backgroundColor: [COLORS.primary, COLORS.secondary, COLORS.success, COLORS.warning],
          borderWidth: 2,
          borderColor: '#0a1628'
        }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
  }

  // 4. Avg resolution time by category
  destroyChart('resolution');
  const ctxRes = document.getElementById('chart-resolution');
  if (ctxRes) {
    charts.resolution = new Chart(ctxRes, {
      type: 'bar',
      data: {
        labels: data.resolutionByCategory.map(d => d.category),
        datasets: [{
          label: 'Avg Hours',
          data: data.resolutionByCategory.map(d => parseFloat(d.avg_hours || 0).toFixed(1)),
          backgroundColor: COLORS.primary,
          borderRadius: 4
        }]
      },
      options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } } }
    });
  }

  // 5. SLA Donut
  destroyChart('sla');
  const ctxSla = document.getElementById('chart-sla');
  if (ctxSla) {
    const total = data.sla.met + data.sla.missed + data.sla.breached;
    const pct = total > 0 ? Math.round(data.sla.met / total * 100) : 100;
    document.getElementById('sla-pct').textContent = pct + '%';
    document.getElementById('sla-detail').textContent = `${data.sla.met} met · ${data.sla.missed} missed · ${data.sla.breached} active breach`;
    charts.sla = new Chart(ctxSla, {
      type: 'doughnut',
      data: {
        labels: ['Met', 'Missed', 'Active Breach'],
        datasets: [{
          data: [data.sla.met, data.sla.missed, data.sla.breached],
          backgroundColor: [COLORS.success, COLORS.warning, COLORS.danger],
          borderWidth: 2, borderColor: '#0a1628'
        }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
  }

  // 6. Busiest sites
  destroyChart('sites');
  const ctxSites = document.getElementById('chart-sites');
  if (ctxSites) {
    charts.sites = new Chart(ctxSites, {
      type: 'bar',
      data: {
        labels: data.busiestSites.map(d => d.site),
        datasets: [{
          data: data.busiestSites.map(d => d.cnt),
          backgroundColor: COLORS.secondary,
          borderRadius: 4
        }]
      },
      options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } } }
    });
  }

  // 7. Hours per tech
  destroyChart('hours');
  const ctxHours = document.getElementById('chart-hours');
  if (ctxHours) {
    charts.hours = new Chart(ctxHours, {
      type: 'bar',
      data: {
        labels: data.hoursPerTech.map(d => d.name),
        datasets: [{
          label: 'Hours',
          data: data.hoursPerTech.map(d => parseFloat(d.hours || 0).toFixed(2)),
          backgroundColor: COLORS.warning,
          borderRadius: 4
        }]
      },
      options: { responsive: true, plugins: { legend: { display: false } } }
    });
  }
}

// AI report
const btnAiReport = document.getElementById('btn-ai-report');
if (btnAiReport) {
  btnAiReport.addEventListener('click', async () => {
    const container = document.getElementById('ai-report-container');
    const content = document.getElementById('ai-report-content');
    container.classList.remove('hidden');
    content.textContent = 'Generating AI summary…';
    btnAiReport.disabled = true;
    try {
      const r = await fetch('/api/ai/summary-report', {
        method: 'POST',
        headers: { 'X-CSRF-Token': window.csrfToken || '' }
      });
      const data = await r.json();
      content.textContent = data.narrative || data.error || 'Unable to generate summary.';
    } catch(e) {
      content.textContent = 'Error: ' + e.message;
    }
    btnAiReport.disabled = false;
  });
}

// Load on page init
loadCharts();
