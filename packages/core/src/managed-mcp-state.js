'use strict';
const { runWithCleanupSync } = require('./run-with-cleanup');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {unlinkOwnedFileSync}=require('./owned-file');
const {performance}=require('node:perf_hooks');
const SCHEMA = 'isingq-managed-mcp-v2';
const MAINTENANCE_SCHEMA='isingq-mcp-maintenance-v1';
function locations(root,id) {
  if (typeof id !== 'string' || !id || id.length > 120) throw Error('invalid managed connection id');
  const directory = path.join(root,'mcp-connections');
  const key = crypto.createHash('sha256').update(id).digest('hex');
  return {directory,record:path.join(directory,key+'.json'),live:path.join(directory,key+'.live.json'),handoff:path.join(directory,key+'.handoff.json'),lock:path.join(directory,key+'.lock'),activity:path.join(directory,key+'.activity.lock')};
}
function read(file) {
  let fd;
  return runWithCleanupSync(() => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('unsafe managed state');
      fd = fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const buffer = Buffer.alloc(65537), size=fs.readSync(fd,buffer,0,buffer.length,0);
      if(size>65536) throw Error('managed state too large');
      return JSON.parse(buffer.toString('utf8',0,size));
    } catch(error) {if(error.code==='ENOENT')return null;throw error;}
  }, () => {
    if(fd!==undefined)fs.closeSync(fd);
  });
}
function directory(dir) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(dir);
  if(!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid==='function' && stat.uid!==process.getuid()))throw Error('unsafe managed directory');
}
function write(file,value) {
  directory(path.dirname(file));
  const temporary=file+'.'+crypto.randomBytes(12).toString('hex')+'.tmp';
  let fd,created=false;
  try {
    fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);created=true;
    fs.writeFileSync(fd,JSON.stringify(value)+'\n');
    const ownedFd=fd;fd=undefined;fs.closeSync(ownedFd);
    fs.renameSync(temporary,file);created=false;
  } finally {
    if(fd!==undefined){const ownedFd=fd;fd=undefined;try{fs.closeSync(ownedFd);}catch{}}
    if(created)try{fs.unlinkSync(temporary);}catch{}
  }
}
function alive(pid) {
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try {process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}
}
const LOCK_SCHEMA='isingq-managed-lock-v1';
function lockSnapshot(file) {
  let fd;
  return runWithCleanupSync(() => {
    try {
      fd=fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat=fs.fstatSync(fd);
      if(!stat.isFile() || stat.size>4096 || (typeof process.getuid==='function' && stat.uid!==process.getuid()))throw Error('unsafe managed lock');
      const bytes=Buffer.alloc(4097),size=fs.readSync(fd,bytes,0,bytes.length,0);
      if(size>4096)throw Error('unsafe managed lock');
      const raw=bytes.subarray(0,size);let value;try{value=JSON.parse(raw.toString('utf8'));}catch{}
      const known=value && Number.isSafeInteger(value.pid) && value.pid>0 && /^(?:[a-f0-9]{24}|[a-f0-9]{64})$/.test(value.token || '')
        && (value.schema===LOCK_SCHEMA || (Object.keys(value).length===2 && Object.hasOwn(value,'pid') && Object.hasOwn(value,'token')));
      return {stat,value,signature:crypto.createHash('sha256').update(String(stat.ino)+':').update(raw).digest('hex'),stale:known ? !alive(value.pid) : size===0 && Date.now()-stat.mtimeMs>5000};
    }catch(error){if(error.code==='ENOENT')return null;throw error;}
  }, () => {
    if(fd!==undefined)fs.closeSync(fd);
  });
}
function acquireUntil(file,deadline,depth=0) {
  directory(path.dirname(file));let first=true;
  while(first || performance.now()<deadline) {
    first=false;let fd;
    try {fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);}
    catch(error){if(error.code!=='EEXIST')throw error;}
    if(fd!==undefined) {
      let identity;
      try {
        identity=fs.fstatSync(fd);
        const token=crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(fd,JSON.stringify({schema:LOCK_SCHEMA,pid:process.pid,token,created_at:Date.now()}));
        const ownedFd=fd;fd=undefined;fs.closeSync(ownedFd);
        const check=lockSnapshot(file);
        if(!check || check.stat.ino!==identity.ino || check.stat.dev!==identity.dev || check.value?.token!==token)throw Error('managed lock ownership changed');
        return ()=>{try{const current=lockSnapshot(file);if(current?.value?.token===token)unlinkOwnedFileSync(file,identity);}catch{}};
      } catch(error) {
        // A failed first fstat can be transient. Retry while the descriptor is
        // still ours; partial JSON cannot establish (or disprove) ownership.
        if(fd!==undefined){if(!identity)try{identity=fs.fstatSync(fd);}catch{} const ownedFd=fd;fd=undefined;try{fs.closeSync(ownedFd);}catch{}}
        try{unlinkOwnedFileSync(file,identity);}catch{}
        throw error;
      }
    }
    const previous=lockSnapshot(file);
    if(!previous){first=true;continue;}
    if(previous.stale && depth<4) {
      // Serialize recovery for this exact former owner. A late recovery never
      // removes a replacement owner's lock; crashed recovery is itself bounded.
      const recovery=path.join(path.dirname(file),'.isingq-recover-'+crypto.createHash('sha256').update(file+':'+previous.signature).digest('hex').slice(0,40)+'.lock');
      const release=acquireUntil(recovery,deadline,depth+1);
      try {const current=lockSnapshot(file);if(current?.signature===previous.signature && current.stale)unlinkOwnedFileSync(file,current.stat);}
      finally{release();}
      first=true;continue;
    }
    if(performance.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
  }
  throw Object.assign(Error('managed state is busy; no change applied'),{code:'managed_state_busy'});
}
function acquire(file,{timeoutMs=1000}={}) {return acquireUntil(file,performance.now()+timeoutMs);}
function exclusive(file,work,options) {const release=acquire(file,options);try{return work();}finally{release();}}
function activity(file,id) {
  const value=read(file);if(!value)return null;
  if(value.schema!==SCHEMA || value.connection_id!==id || !/^[a-f0-9]{64}$/.test(value.token || '') || !Array.isArray(value.instances)
    || value.instances.length>256 || value.instances.some(item=>!Number.isSafeInteger(item.pid) || item.pid<=0 || !/^[a-f0-9]{24}$/.test(item.instance_id || '') || !Number.isSafeInteger(item.busy) || item.busy<0)
    || new Set(value.instances.map(item=>item.instance_id)).size!==value.instances.length
    || !Number.isSafeInteger(value.busy) || value.busy!==value.instances.reduce((sum,item)=>sum+item.busy,0))throw Error('invalid managed MCP activity record');
  const instances=value.instances.filter(item=>alive(item.pid));
  return {...value,instances,busy:instances.reduce((sum,item)=>sum+item.busy,0)};
}
function serverControl(environment=process.env) {
  const id=environment.ISINGQ_MANAGED_MCP_ID,token=environment.ISINGQ_MANAGED_MCP_TOKEN;
  if(!id || !/^[a-f0-9]{64}$/.test(token || ''))return null;
  const root=path.resolve(environment.ISINGQ_RUNTIME_DIR || path.join(os.homedir(),'.isingq-runtime'));
  const paths=locations(root,id);directory(paths.directory);
  const instance=crypto.randomBytes(12).toString('hex');
  const own=()=>({instance_id:instance,pid:process.pid,busy:0});
  const selected=value=>value?.token===token ? value.instances.find(item=>item.instance_id===instance && item.pid===process.pid) : null;
  const save=value=>write(paths.live,{...value,busy:value.instances.reduce((sum,item)=>sum+item.busy,0)});
  const desired=()=>{if(environment.ISINGQ_MANAGED_MCP_REQUIRE_RECORD!=='1')return true;const value=read(paths.record);return value?.schema===MAINTENANCE_SCHEMA && value.connection_id===id && value.token===token;};
  const handoff=()=>{const value=read(paths.handoff);return value?.schema===SCHEMA && value.connection_id===id && value.token===token && Number.isSafeInteger(value.expires_at) && value.expires_at>Date.now();};
  exclusive(paths.activity,()=>{
    // A cached Host process can still answer identity queries, but must never
    // replace the desired generation's activity record while starting late.
    if(!desired())return;
    const previous=activity(paths.live,id);
    if(previous && previous.token!==token && previous.busy>0)throw Error('managed MCP is busy; activation deferred');
    const instances=previous?.token===token ? previous.instances : [];
    if(instances.length>=256)throw Error('too many active managed MCP clients');
    instances.push(own());save({schema:SCHEMA,connection_id:id,token,instances});
  });
  let closed=false;
  const close=()=>{if(closed)return true;let completed=true;try{if(fs.existsSync(paths.live))exclusive(paths.activity,()=>{
    const value=activity(paths.live,id),item=selected(value);if(!item)return;if(item.busy>0){completed=false;return;}
    value.instances=value.instances.filter(entry=>entry.instance_id!==instance);
    if(value.instances.length)save(value);else fs.unlinkSync(paths.live);
  });}catch{completed=false;}if(completed){closed=true;process.removeListener('exit',close);}return completed;};
  process.once('exit',close);
  return {
    begin(request) {
      if(request.method!=='tools/call' || request.params?.name==='isingq_modeling_guide_get')return ()=>{};
      exclusive(paths.activity,()=>{
        const value=activity(paths.live,id),item=selected(value);
        if(!item || !desired() || handoff())throw Object.assign(Error('工具连接正在安全更新或已被新版接管，请继续使用原服务的新连接；未创建新任务。'),{code:-32001});
        item.busy++;save(value);
      });
      let released=false,pending=null;
      const complete=()=>{
        if(released)return;
        exclusive(paths.activity,()=>{const value=activity(paths.live,id),item=selected(value);if(item){item.busy--;save(value);}},{timeoutMs:0});
        released=true;
      };
      return ()=>{
        if(released)return;if(pending)return pending;
        try {return complete();}catch(error){if(error.code!=='managed_state_busy')throw error;}
        // Yield while another legitimate owner commits activity. Completing a
        // tool must not block that owner's timer or mark an unwritten decrement
        // as done. The caller awaits this bounded cleanup before its next call.
        pending=(async()=>{
          const deadline=performance.now()+5000;
          while(performance.now()<deadline) {
            await new Promise(resolve=>setTimeout(resolve,10));
            try{return complete();}catch(error){if(error.code!=='managed_state_busy')throw error;}
          }
          throw Object.assign(Error(`MCP调用已结束，但活动登记在5000ms内未能收尾（connection_id=${id}）；请检查活动锁，重连此服务后继续，勿重复提交原任务。`),{code:'managed_cleanup_busy'});
        })().finally(()=>{pending=null;});
        return pending;
      };
    }, close,
  };
}
module.exports={SCHEMA,MAINTENANCE_SCHEMA,locations,read,write,directory,alive,acquire,exclusive,activity,serverControl};
