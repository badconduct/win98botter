"use strict";
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const image=process.argv[2]||'win98botter:ci';
const name='botter-relay-test-'+Date.now();
let volume=false, running=false;
function docker(args) {return execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}
async function start() {
  docker(['run','--detach','--name',name,'--init','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges:true','--memory','256m','--pids-limit','96',
    '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m','--mount',`type=volume,src=${name},dst=/data`,
    '--publish','127.0.0.1::3000','--env','BOT_API_URL=http://127.0.0.1:1/v1',image]);
  running=true;
  const port=docker(['port',name,'3000/tcp']).split(':').at(-1);
  const base='http://127.0.0.1:'+port;
  for(let i=0;i<40;i++) {
    try {const r=await fetch(base+'/health'); if(r.ok && (await r.json()).relay)return base;}catch{}
    await new Promise(r=>setTimeout(r,250));
  }
  throw Error('Relay readiness failed');
}
(async()=>{
  docker(['volume','create',name]); volume=true;
  let base=await start();
  docker(['exec',name,'sh','-c','! command -v npm && ! command -v npx && ! command -v yarn']);
  assert.match(await (await fetch(base+'/')).text(),/id="root"/);
  const response=await fetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({BOT_API_URL:'http://127.0.0.1:1/v1',BOT_MODEL:'persistence-test'})});
  assert.equal(response.status,200);
  docker(['exec',name,'node','-e',"const D=require('better-sqlite3'); const d=new D('/data/relay.db'); d.prepare('INSERT INTO agents(agent_id,hostname,ip_address,first_seen,last_seen) VALUES (?,?,?,?,?)').run('test','test','127.0.0.1','now','now');d.close();"]);
  docker(['stop','--time','10',name]);
  const state=JSON.parse(docker(['inspect',name]))[0];
  assert.equal(state.State.ExitCode,0);
  assert.equal(state.HostConfig.ReadonlyRootfs,true);
  assert.equal(state.Config.User,'node');
  docker(['rm',name]);running=false;
  base=await start();
  assert.equal((await (await fetch(base+'/api/config')).json()).BOT_MODEL,'persistence-test');
  docker(['exec',name,'node','-e',"const D=require('better-sqlite3');const d=new D('/data/relay.db');if(d.prepare('SELECT count(*) AS n FROM agents WHERE agent_id=?').get('test').n!==1)process.exit(1);d.close();"]);
  console.log('PASS: hardened UI/health/config, clean stop, container replacement, SQLite and config persistence');
})().catch(error=>{console.error('Container acceptance failed:',error.message);process.exitCode=1;})
.finally(()=>{if(running){docker(['stop','--time','10',name]);docker(['rm',name]);}if(volume)docker(['volume','rm',name]);});
