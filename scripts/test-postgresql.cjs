// CI/workstation rehearsal. Creates only uniquely named disposable Docker
// resources, with tmpfs PGDATA and no published ports. No live DB is accessed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const name = 'botter-pg-test-'+Date.now();
const dir = fs.mkdtempSync(path.join(__dirname,'pg-test-'));
fs.chmodSync(dir, 0o755); // Synthetic fixture files must be readable by test containers.
const linuxDir = process.platform === 'win32'
  ? '/mnt/'+dir[0].toLowerCase()+dir.slice(2).replaceAll('\\','/') : dir;
const relayImage = process.argv[2] || 'win98botter:ci';
const image='postgres:18.6-bookworm@sha256:a10c981235b4f635e65df0cfb66a5598064628128505dbc6a3ed4ca303717521';
function docker(args,input) {return execFileSync('docker',args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});}
let network=false, container=false, stage='credentials';
(async()=>{
  const admin=crypto.randomBytes(24).toString('hex');
  const runtime=crypto.randomBytes(24).toString('hex');
  const migrator=crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(dir,'admin-password'),admin);
  fs.writeFileSync(path.join(dir,'runtime-password'),runtime);
  fs.writeFileSync(path.join(dir,'migrator-password'),migrator);
  stage='certificate generation';
  execFileSync(process.platform === 'win32' ? 'wsl' : 'openssl',[
    ...(process.platform === 'win32' ? ['-d','Debian','--','openssl'] : []),
    'req','-x509','-newkey','rsa:2048','-nodes','-days','1',
    '-subj','/CN=botter-pg-test','-addext','subjectAltName=DNS:botter-pg-test',
    '-keyout',linuxDir+'/server.key','-out',linuxDir+'/server.crt'],{stdio:'pipe'});
  stage='network creation';
  docker(['network','create','--internal',name]); network=true;
  stage='database launch';
  docker(['run','--detach','--name',name,'--network',name,'--network-alias','botter-pg-test',
    '--mount',`type=bind,source=${dir},target=/run/test,readonly`,
    '--tmpfs','/var/lib/postgresql:rw,size=256m','--tmpfs','/tmp:rw,size=16m',
    '--env','POSTGRES_PASSWORD_FILE=/run/test/admin-password',
    '--env','POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
    '--entrypoint','sh',image,'-c',
    'cp /run/test/server.key /tmp/server.key && chown postgres:postgres /tmp/server.key && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/run/test/server.crt -c ssl_key_file=/tmp/server.key']);
  container=true;
  stage='readiness';
  let ready=false;
  for(let i=0;i<60;i++) {
    try {docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']); ready=true; break;}
    catch {await new Promise(r=>setTimeout(r,500));}
  }
  if(!ready) throw Error('Database readiness timed out');
  // No credentials in process arguments or logs: SQL is sent on stdin.
  stage='role provisioning';
  docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],
    `CREATE ROLE botter_owner NOLOGIN; CREATE ROLE botter_app LOGIN NOINHERIT PASSWORD '${runtime}'; CREATE ROLE botter_migrator LOGIN NOINHERIT PASSWORD '${migrator}'; GRANT botter_owner TO botter_migrator WITH INHERIT FALSE; CREATE DATABASE botter_test OWNER botter_owner;`);
  stage='schema migration';
  docker(['exec','-i',name,'psql','-U','postgres','-d','botter_test','-v','ON_ERROR_STOP=1'],
    `BEGIN; ALTER SCHEMA public OWNER TO botter_owner; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO botter_app; ALTER DEFAULT PRIVILEGES FOR ROLE botter_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO botter_app; ALTER DEFAULT PRIVILEGES FOR ROLE botter_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO botter_app; COMMIT;`);
  for (const changed of [true,false]) {
    const result = JSON.parse(docker(['run','--rm','--network',name,'--read-only',
      '--mount',`type=bind,source=${dir},target=/run/test,readonly`,
      '--env','PHASE1_PG_HOST=botter-pg-test','--env','PHASE1_PG_DATABASE=botter_test',
      '--env','PHASE1_PG_USER=botter_migrator','--env','PHASE1_PG_PASSWORD_FILE=/run/test/migrator-password',
      '--env','PHASE1_PG_CA_FILE=/run/test/server.crt','--env','MIGRATION_OWNER_ROLE=botter_owner',
      '--env','MIGRATION_RUNTIME_ROLE=botter_app','--entrypoint','node',relayImage,'db/migrate-map.js']));
    if(result.changed!==changed || result.version!==1) throw Error('Migration idempotence failed');
  }
  stage='runtime assertions';
  const output=docker(['run','--rm','--network',name,'--read-only','--tmpfs','/tmp:rw,size=16m',
    '--mount',`type=bind,source=${path.join(__dirname,'postgres-worker.cjs')},target=/app/pg-map-worker.cjs,readonly`,
    '--mount',`type=bind,source=${dir},target=/run/test,readonly`,
    '--entrypoint','node',relayImage,'pg-map-worker.cjs']);
  console.log(output.trim());
})().catch(error=>{ console.error('Disposable PostgreSQL rehearsal failed at',stage,':',error.status||'error'); console.error(String(error.stderr||'').replace(/[0-9a-f]{48}/gi,'[redacted]')); process.exitCode=1; })
.finally(()=>{
  if(container) docker(['rm','--force',name]);
  if(network) docker(['network','rm',name]);
  // Exact mkdtemp output under this ignored test folder, never a workspace root.
  fs.rmSync(dir,{recursive:true,force:true});
});
