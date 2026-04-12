'use strict';
const MlinkConnector = require('./mlink-connector');
const EnbaseConnector = require('./enbase-connector');
const NetsuiteConnector = require('./netsuite-connector');
const FieldawareConnector = require('./fieldaware-connector');
const EmailConnector = require('./email-connector');

const REGISTRY = {
  mlink: MlinkConnector,
  enbase: EnbaseConnector,
  netsuite: NetsuiteConnector,
  fieldaware: FieldawareConnector,
  email: EmailConnector
};

function get(type) {
  return REGISTRY[type] || null;
}

function list() {
  return Object.keys(REGISTRY);
}

module.exports = { get, list };
