'use strict';
/**
 * Fleet Monitor — FW Murphy MLink integration
 * Serves the /fleet page and proxies MLink data server-side
 * so the API key never touches the browser.
 *
 * Data priority:
 *  1. MLink DataStore (Cody's Railway hub, already caching/polling)
 *  2. FW Murphy API direct (MLINK_API_KEY fallback)
 */
const express = require('express');
const https = require('https');
const http = require('http');
const { requireAuth } = require('../middleware/authenticate');
const router = express.Router();

// ── Device definitions ───────────────────────────────────────────────────────
const DEVICES = [
  { id: '2504-504495', name: 'Panel',        type: 'panel' },
  { id: '2504-505561', name: 'Compressor A', type: 'compressor' },
  { id: '2504-505472', name: 'Compressor B', type: 'compressor' },
];

// ── Alarm thresholds ─────────────────────────────────────────────────────────
const THRESHOLDS = {
  'Discharge Temperature':   { high_warn: 280, high_crit: 320, unit: '°F' },
  'Suction Pressure':        { low_warn: 20,   low_crit: 10,   unit: 'psi(g)' },
  'Discharge Pressure':      { high_warn: 860, high_crit: 950, unit: 'psi(g)' },
  'Engine Oil Pressure':     { low_warn: 40,   low_crit: 25,   unit: 'psig' },
  'System Voltage':          { low_warn: 24,   low_crit: 22,   unit: 'VDC' },
  'Compressor Oil Pressure': { low_warn: 50,   low_crit: 35,   unit: 'psi(g)' },
};

// Priority display order per device type
const COMPRESSOR_KEY_TAGS = [
  'Engine Speed', 'Driver Speed', 'Engine Oil Pressure', 'System Voltage',
  'Suction Pressure', 'Discharge Pressure', 'Compressor Oil Pressure',
  'Discharge Temperature', 'Hour Meter'
];
const PANEL_KEY_TAGS = [
  'Hour Meter', 'System Voltage',
  'Well #1 Flow Rate', 'Well #2 Flow Rate', 'Well #3 Flow Rate', 'Well #4 Flow Rate',
  'Total Flow Rate'
];

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── MLink DataStore proxy ─────────────────────────────────────────────────────
async function fromDataStore(path) {
  const base = (process.env.MLINK_DATASTORE_URL || 'https://mlink-datastore.up.railway.app').replace(/\/$/, '');
  try {
    const res = await httpGet(`${base}${path}`);
    if (res.status === 200 && res.body?.success !== false) return res.body;
  } catch {}
  return null;
}

// ── FW Murphy direct fetch ────────────────────────────────────────────────────
const FW_BASE = 'https://api.fwmurphy-iot.com/api';

async function fwLatest(deviceId) {
  const key = process.env.MLINK_API_KEY;
  if (!key) return null;
  try {
    const res = await httpGet(`${FW_BASE}/LatestDeviceData?deviceId=${encodeURIComponent(deviceId)}&code=${encodeURIComponent(key)}`);
    if (res.status === 200 && res.body) return res.body;
  } catch {}
  return null;
}

async function fwHistory(deviceId, startTs, endTs) {
  const key = process.env.MLINK_API_KEY;
  if (!key) return null;
  try {
    const res = await httpGet(`${FW_BASE}/RunReport?deviceId=${encodeURIComponent(deviceId)}&startTs=${startTs}&endTs=${endTs}&code=${encodeURIComponent(key)}`);
    if (res.status === 200) return res.body;
  } catch {}
  return null;
}

// ── Normalize FW Murphy raw response → standard format ───────────────────────
function normalizeFwResponse(raw, deviceId) {
  if (!raw) return null;
  const ts = Array.isArray(raw.timestamps) ? raw.timestamps[0] : (raw.timestamp || Math.floor(Date.now() / 1000));
  const readings = (raw.datapoints || []).map(dp => ({
    alias: dp.alias,
    description: dp.desc || dp.description || dp.alias,
    value: dp.value,
    units: dp.units || '',
    timestamp: ts
  }));
  return { device_id: deviceId, collected_at: Date.now(), readings };
}

// ── Build alarm list from readings ────────────────────────────────────────────
function buildAlarms(deviceName, readings) {
  const alarms = [];
  for (const r of readings) {
    if (r.value == null) continue;
    const t = THRESHOLDS[r.alias];
    if (!t) continue;
    if (t.high_crit != null && r.value >= t.high_crit)
      alarms.push({ device: deviceName, tag: r.alias, value: r.value, units: r.units, level: 'critical', msg: `HIGH CRITICAL: ${r.value} ${r.units} ≥ ${t.high_crit}` });
    else if (t.high_warn != null && r.value >= t.high_warn)
      alarms.push({ device: deviceName, tag: r.alias, value: r.value, units: r.units, level: 'warning', msg: `HIGH WARNING: ${r.value} ${r.units} ≥ ${t.high_warn}` });
    else if (t.low_crit != null && r.value <= t.low_crit)
      alarms.push({ device: deviceName, tag: r.alias, value: r.value, units: r.units, level: 'critical', msg: `LOW CRITICAL: ${r.value} ${r.units} ≤ ${t.low_crit}` });
    else if (t.low_warn != null && r.value <= t.low_warn)
      alarms.push({ device: deviceName, tag: r.alias, value: r.value, units: r.units, level: 'warning', msg: `LOW WARNING: ${r.value} ${r.units} ≤ ${t.low_warn}` });
  }
  return alarms;
}

function alarmLevel(alias, value) {
  if (value == null) return 'normal';
  const t = THRESHOLDS[alias];
  if (!t) return 'normal';
  if ((t.high_crit != null && value >= t.high_crit) || (t.low_crit != null && value <= t.low_crit)) return 'critical';
  if ((t.high_warn != null && value >= t.high_warn) || (t.low_warn != null && value <= t.low_warn)) return 'warning';
  return 'normal';
}

// ── Fetch latest data for all devices ────────────────────────────────────────
async function fetchAllLatest() {
  // Try DataStore first (already has history + caching)
  const ds = await fromDataStore('/api/latest');
  if (ds && ds.data && Array.isArray(ds.data)) {
    return ds.data.map(d => {
      const dev = DEVICES.find(x => x.id === d.device_id);
      return {
        ...d,
        name: dev?.name || d.device_id,
        type: dev?.type || 'unknown',
        alarms: buildAlarms(dev?.name || d.device_id, d.readings || [])
      };
    });
  }

  // Fallback: direct FW Murphy API
  const results = await Promise.all(DEVICES.map(async dev => {
    const raw = await fwLatest(dev.id);
    const normalized = normalizeFwResponse(raw, dev.id);
    const readings = normalized?.readings || [];
    return {
      device_id: dev.id,
      name: dev.name,
      type: dev.type,
      readings,
      collected_at: normalized?.collected_at || null,
      alarms: buildAlarms(dev.name, readings)
    };
  }));
  return results;
}

// ── API: latest data JSON ─────────────────────────────────────────────────────
router.get('/api/latest', requireAuth, async (req, res) => {
  try {
    const data = await fetchAllLatest();
    // Annotate each reading with alarm level
    const annotated = data.map(d => ({
      ...d,
      readings: (d.readings || []).map(r => ({ ...r, alarm: alarmLevel(r.alias, r.value) }))
    }));
    res.json({ ok: true, ts: Date.now(), devices: annotated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: history for sparklines ───────────────────────────────────────────────
router.get('/api/history', requireAuth, async (req, res) => {
  const { deviceId, tag, hours = 24 } = req.query;
  if (!deviceId || !tag) return res.status(400).json({ ok: false, error: 'deviceId and tag required' });

  // Try DataStore
  const ds = await fromDataStore(`/api/history?deviceId=${encodeURIComponent(deviceId)}&tag=${encodeURIComponent(tag)}&hours=${hours}`);
  if (ds && ds.data) return res.json({ ok: true, data: ds.data });

  // Fallback: direct FW Murphy RunReport
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - (parseInt(hours) * 3600);
  const raw = await fwHistory(deviceId, startTs, endTs);
  if (raw) {
    // Normalize RunReport — filter to matching tag
    const points = [];
    if (Array.isArray(raw.timestamps) && Array.isArray(raw.datapoints)) {
      for (let i = 0; i < raw.timestamps.length; i++) {
        const dp = Array.isArray(raw.datapoints[i]) ? raw.datapoints[i] : raw.datapoints;
        const match = (Array.isArray(dp) ? dp : [dp]).find(d => d.alias === tag || d.desc === tag);
        if (match) points.push({ timestamp: raw.timestamps[i], value: match.value, units: match.units });
      }
    }
    return res.json({ ok: true, data: points });
  }

  res.json({ ok: true, data: [] });
});

// ── API: DataStore status/stats ───────────────────────────────────────────────
router.get('/api/status', requireAuth, async (req, res) => {
  const ds = await fromDataStore('/api/status');
  if (ds) return res.json({ ok: true, source: 'datastore', ...ds });
  res.json({ ok: false, source: 'none', error: 'DataStore unavailable and no direct connection' });
});

// ── Page render ───────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const data = await fetchAllLatest();
    const annotated = data.map(d => ({
      ...d,
      readings: (d.readings || []).map(r => ({ ...r, alarm: alarmLevel(r.alias, r.value) }))
    }));
    const allAlarms = annotated.flatMap(d => d.alarms);
    const lastUpdate = annotated.find(d => d.collected_at)?.collected_at;

    res.render('fleet', {
      title: 'Fleet Monitor',
      devices: annotated,
      allAlarms,
      lastUpdate,
      COMPRESSOR_KEY_TAGS,
      PANEL_KEY_TAGS,
      user: req.session.user,
      unreadCount: res.locals.unreadCount || 0
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Fleet Error', message: err.message, user: req.session.user, unreadCount: 0 });
  }
});

module.exports = router;
