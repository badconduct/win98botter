const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Pool } = require('pg');
const { postgresConfig } = require('./db/postgres-config');
const { createPhase1Store } = require('./db/phase1-store');
const cfg = { phase1PgEnabled:'1', phase1PgSchemaMode:'external',
  phase1PgSsl:'1', phase1PgHost:'botter-pg-test', phase1PgPort:5432,
  phase1PgDatabase:'botter_test', phase1PgUser:'botter_app',
  phase1PgPasswordFile:'/run/test/runtime-password', phase1PgCaFile:'/run/test/server.crt' };
(async () => {
  const store = createPhase1Store(cfg, {info(){}});
  const pool = new Pool(postgresConfig(cfg));
  try {
    await store.init();
    assert.equal((await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl,true);
    await store.upsertDirScan({agentId:'test-pc',dirPath:'C:\\TEST',entries:[{name:'sample.txt',entry_type:'file',size_bytes:42}],sourceTool:'test'});
    const entries = await store.listDirEntries({agentId:'test-pc',dirPath:'C:\\TEST'});
    assert.equal(entries[0].name,'sample.txt');
    assert.equal((await store.listDirEntries({agentId:'other-pc',dirPath:'C:\\TEST'})).length,0);
    await store.saveFileReadCapture({agentId:'test-pc',filePath:'C:\\TEST\\sample.txt',content:'round trip',is_partial:false});
    assert.equal((await store.listFileReadCaptures({agentId:'test-pc',filePath:'C:\\TEST\\sample.txt',limit:10}))[0].is_partial,false);
    assert.equal((await pool.query('SELECT content FROM phase1_file_reads WHERE agent_id=$1',['test-pc'])).rows[0].content,'round trip');
    await assert.rejects(pool.query('CREATE TABLE forbidden(id int)'), /permission denied/);
    await assert.rejects(pool.query('DELETE FROM relay_schema_migrations'), /permission denied/);
    const untrusted = new Pool({...postgresConfig(cfg),ssl:{rejectUnauthorized:true}});
    try { await assert.rejects(untrusted.query('SELECT 1'), {code:'DEPTH_ZERO_SELF_SIGNED_CERT'}); } finally { await untrusted.end(); }
    const wrongPassword = new Pool({...postgresConfig(cfg),password:'deliberately-wrong'});
    try { await assert.rejects(wrongPassword.query('SELECT 1'), /password authentication failed/); } finally { await wrongPassword.end(); }
    console.log('PASS: PG18 migration, verified TLS, map/file round trips, agent separation, denied runtime DDL, wrong-CA and wrong-password rejection');
  } finally { await store.close(); await pool.end(); }
})().catch(error => { console.error('PostgreSQL integration assertion failed:',error.code||'', String(error.message).replace(/[0-9a-f]{48}/gi,'[redacted]')); process.exitCode=1; });
