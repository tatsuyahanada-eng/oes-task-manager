'use strict';

const oracle = require('./oracle');
const mssql = require('./mssql');
const postgres = require('./postgres');
const mysql = require('./mysql');

const DRIVERS = {
  [oracle.id]: oracle,
  [mssql.id]: mssql,
  [postgres.id]: postgres,
  [mysql.id]: mysql,
};

function getDriver(type) {
  const driver = DRIVERS[type];
  if (!driver) {
    const e = new Error(`未対応のDB種別です: ${type}`);
    e.status = 400;
    throw e;
  }
  return driver;
}

/** 画面のDB種別プルダウン用メタデータ。 */
function driverCatalog() {
  return Object.values(DRIVERS).map((d) => ({
    id: d.id,
    label: d.label,
    defaultPort: d.defaultPort,
    supportsDatabaseSwitch: d.supportsDatabaseSwitch,
    installed: isInstalled(d.id),
  }));
}

const MODULE_BY_DRIVER = { oracle: 'oracledb', mssql: 'mssql', postgres: 'pg', mysql: 'mysql2' };

function isInstalled(id) {
  try {
    require.resolve(MODULE_BY_DRIVER[id]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { DRIVERS, getDriver, driverCatalog, isInstalled };
