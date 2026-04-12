// Vercel serverless entry point
require('dotenv').config();
const app = require('../src/server');
module.exports = app;
