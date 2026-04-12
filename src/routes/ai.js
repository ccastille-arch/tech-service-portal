'use strict';
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/authenticate');
const { getDb } = require('../database');
const router = express.Router();

let anthropic;
function getClient() {
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

router.post('/categorize', requireAuth, async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) return res.json({ category: 'general', reasoning: 'No description provided.' });

    const client = getClient();
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `You are a field service dispatcher. Categorize this work order description into exactly one of these categories: electrical, mechanical, instrumentation, controls, general.

Description: "${description}"

Respond with valid JSON only: {"category": "...", "reasoning": "one sentence"}`
      }]
    });

    const text = msg.content[0].text.trim();
    const json = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
    res.json({ category: json.category || 'general', reasoning: json.reasoning || '' });
  } catch (err) {
    console.error('AI categorize error:', err.message);
    res.json({ category: 'general', reasoning: 'AI unavailable — defaulting to general.' });
  }
});

router.post('/suggest-priority', requireAuth, async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title) return res.json({ priority: 'P3', reasoning: 'No title provided.' });

    const client = getClient();
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `You are a field service dispatcher. Suggest a priority for this work order:
P1 = Critical / Safety / Production shutdown (resolve within 4 hours)
P2 = High / Major impact (resolve within 24 hours)
P3 = Medium / Moderate impact (resolve within 72 hours)
P4 = Low / Minor / Planned (resolve within 1 week)

Title: "${title}"
Description: "${description || 'N/A'}"

Respond with valid JSON only: {"priority": "P1|P2|P3|P4", "reasoning": "one sentence"}`
      }]
    });

    const text = msg.content[0].text.trim();
    const json = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
    res.json({ priority: json.priority || 'P3', reasoning: json.reasoning || '' });
  } catch (err) {
    console.error('AI priority error:', err.message);
    res.json({ priority: 'P3', reasoning: 'AI unavailable — defaulting to P3.' });
  }
});

router.post('/summary-report', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const openTickets = db.prepare(`
      SELECT t.ticket_number, t.title, t.priority, t.status, t.category,
             u.name as assigned_name, t.due_date, t.well_site
      FROM tickets t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.status NOT IN ('closed')
      ORDER BY t.priority ASC, t.due_date ASC
      LIMIT 30
    `).all();

    const stats = {
      open: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='open'").get().c,
      inProgress: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='in-progress'").get().c,
      overdue: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status NOT IN ('completed','closed') AND due_date < ?").get(new Date().toISOString()).c
    };

    const client = getClient();
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a field service operations manager. Generate a concise executive summary of current work order status.

Stats: ${stats.open} open, ${stats.inProgress} in-progress, ${stats.overdue} overdue.

Open tickets:
${openTickets.map(t => `- ${t.ticket_number} [${t.priority}][${t.status}] ${t.title} | ${t.category} | ${t.assigned_name || 'Unassigned'} | Site: ${t.well_site || 'N/A'} | Due: ${t.due_date || 'N/A'}`).join('\n')}

Write a 3-5 paragraph executive summary covering: current operational status, priority concerns, resource allocation, and recommended actions. Be direct and specific.`
      }]
    });

    res.json({ narrative: msg.content[0].text });
  } catch (err) {
    console.error('AI summary error:', err.message);
    res.status(500).json({ error: 'AI summary unavailable: ' + err.message });
  }
});

module.exports = router;
