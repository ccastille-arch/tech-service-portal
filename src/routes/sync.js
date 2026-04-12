'use strict';
const express = require('express');
const { requireAdmin } = require('../middleware/authenticate');
const { processSyncQueue } = require('../services/sync-engine');
const router = express.Router();

// Process all pending sync queue items
router.post('/process', requireAdmin, async (req, res) => {
  try {
    const result = await processSyncQueue();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
