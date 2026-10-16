'use strict';
const express = require('express');
const small = express.json({ limit: '1mb' });
const jsonUpload = express.json({ limit: '32mb' });
function jsonPadrao(req, res, next) {
  if (req.method === 'POST' && req.path === '/conciliacao/importar') return next();
  return small(req, res, next);
}
module.exports = { jsonPadrao, jsonUpload };
