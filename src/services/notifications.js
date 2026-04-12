'use strict';
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');

function createNotification(userId, ticketId, type, message) {
  if (!userId) return;
  const db = getDb();
  db.prepare(`
    INSERT INTO notifications (id, user_id, ticket_id, type, message, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(uuidv4(), userId, ticketId || null, type, message, new Date().toISOString());
}

function notifyAssignment(ticket, assignedUserId, actorName) {
  if (!assignedUserId) return;
  createNotification(
    assignedUserId,
    ticket.id,
    'assigned',
    `${actorName} assigned you ticket ${ticket.ticket_number}: ${ticket.title}`
  );
}

function notifyStatusChange(ticket, oldStatus, newStatus, actorName, db) {
  // Notify assigned tech and creator
  const notify = db.prepare('SELECT id FROM users WHERE id IN (?, ?)').all(ticket.assigned_to, ticket.created_by);
  for (const u of notify) {
    if (u.id) {
      createNotification(
        u.id,
        ticket.id,
        'status_changed',
        `${actorName} changed ${ticket.ticket_number} status from ${oldStatus} to ${newStatus}`
      );
    }
  }
}

function notifyOverdue(ticket, db) {
  const notify = [ticket.assigned_to, ticket.created_by].filter(Boolean);
  for (const userId of [...new Set(notify)]) {
    createNotification(
      userId,
      ticket.id,
      'overdue',
      `Ticket ${ticket.ticket_number} is overdue: ${ticket.title}`
    );
  }
}

function getUnreadCount(userId) {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0').get(userId);
  return row ? row.cnt : 0;
}

module.exports = { createNotification, notifyAssignment, notifyStatusChange, notifyOverdue, getUnreadCount };
