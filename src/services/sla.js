'use strict';

const SLA_HOURS = { P1: 4, P2: 24, P3: 72, P4: 168 };

function getSlaStatus(ticket) {
  if (!ticket.due_date) return 'no-sla';
  if (['completed', 'closed'].includes(ticket.status)) return 'met';
  const due = new Date(ticket.due_date);
  const now = new Date();
  const hoursLeft = (due - now) / 3600000;
  if (hoursLeft < 0) return 'breached';
  const threshold = (SLA_HOURS[ticket.priority] || 72) * 0.25;
  if (hoursLeft < threshold) return 'at-risk';
  return 'on-track';
}

function getSlaHours(priority) {
  return SLA_HOURS[priority] || 72;
}

function getDefaultDueDate(priority) {
  const hours = SLA_HOURS[priority] || 72;
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return d.toISOString().slice(0, 16); // datetime-local format
}

module.exports = { getSlaStatus, getSlaHours, getDefaultDueDate, SLA_HOURS };
