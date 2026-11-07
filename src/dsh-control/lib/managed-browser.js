import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ControlError} from './common.js';

// Owns persistent metadata, not the browser process lifetime. Only opaque page
// target IDs and native group identity are stored; no URLs, forms or credentials.
export class ManagedBrowser {
  constructor(config){this.config=config;this.profile=join(config.browserProfileDir||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'dsh-control','browsers'),'shared-groups');this.file=join(this.profile,'dsh-control-sessions.json');this.extension=join(this.profile,'dsh-control-extension');}
  read(){try{if(statSync(this.file).size>1024*1024)return null;const state=JSON.parse(readFileSync(this.file,'utf8'));if(state.version===1&&typeof state.endpoint==='string'&&state.sessions&&typeof state.sessions==='object'&&!Array.isArray(state.sessions))return state;}catch{}return null;}
  saved(owner){const entry=this.read()?.sessions?.[owner];return entry?.owner===owner&&Array.isArray(entry.tabs)&&entry.tabs.length<=512&&Number.isSafeInteger(entry.group?.id)&&Number.isSafeInteger(entry.group?.windowId)?entry:null;}
  entries(){return Object.keys(this.read()?.sessions??{}).map(owner=>this.saved(owner)).filter(Boolean);}
  write(state){mkdirSync(this.profile,{recursive:true});const temp=this.file+'.'+process.pid+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(state));renameSync(temp,this.file);}
  setEndpoint(endpoint){this.endpoint=endpoint;this.controllerId=randomUUID();const previous=this.read();this.write({version:1,endpoint,controllerId:this.controllerId,sessions:previous?.endpoint===endpoint?previous.sessions:{}});}
  isCurrent(){const state=this.read();return !!state&&state.endpoint===this.endpoint&&state.controllerId===this.controllerId;}
  save(owner,value){const state=this.read();if(!state||state.endpoint!==this.endpoint||state.controllerId!==this.controllerId)return;Object.defineProperty(state.sessions,owner,{value:{...value,owner},enumerable:true,writable:true,configurable:true});this.write(state);}
  forget(owner){const state=this.read();if(this.controllerId&&state?.controllerId!==this.controllerId)return;if(state&&Object.hasOwn(state.sessions,owner)){delete state.sessions[owner];this.write(state);}}
  prepareExtension(){mkdirSync(this.extension,{recursive:true});for(const name of ['manifest.json','worker.js']){const bytes=readFileSync(fileURLToPath(new URL('../browser-extension/'+name,import.meta.url))),path=join(this.extension,name);if(!existsSync(path)||!readFileSync(path).equals(bytes))writeFileSync(path,bytes);}return this.extension;}
  address(){try{const [port,path]=readFileSync(join(this.profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);if(/^\d+$/.test(port)&&+port>0&&+port<=65535&&/^\/devtools\/browser\/[\w-]+$/.test(path))return `ws://127.0.0.1:${port}${path}`;}catch{}return null;}
  executable(){
    if(this.config.browserExecutable&&existsSync(this.config.browserExecutable))return this.config.browserExecutable;
    const edge=this.config.browserChannel==='msedge',suffix=edge?'Microsoft/Edge/Application/msedge.exe':'Google/Chrome/Application/chrome.exe';
    const candidates=[process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean).map(root=>join(root,suffix));
    if(this.config.browserChannel==='chromium')candidates.unshift(chromium.executablePath());
    const found=candidates.find(existsSync);if(!found)throw new ControlError('BROWSER_EXECUTABLE_REQUIRED','未找到浏览器，请在插件配置 browserExecutable 指定 Chrome/Edge 路径');return found;
  }
  async connect(){
    mkdirSync(this.profile,{recursive:true});this.prepareExtension();
    let endpoint=this.address();
    const attach=async address=>{const browser=await chromium.connectOverCDP(address,{timeout:2500,noDefaults:true});const context=browser.contexts()[0];if(!context){await browser.close();throw new Error('No browser context');}context.setDefaultTimeout(this.config.operationTimeoutMs);context.setDefaultNavigationTimeout(this.config.operationTimeoutMs);this.setEndpoint(address);return {browser,context,extensionPath:this.extension};};
    if(endpoint){try{return await attach(endpoint);}catch{/* stale port file after the user closed Chrome */}}
    const child=spawn(this.executable(),[`--user-data-dir=${this.profile}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--force-renderer-accessibility','about:blank'],{detached:true,stdio:'ignore',windowsHide:false});
    let failed;child.on('error',e=>failed=e);child.unref();const until=Date.now()+this.config.operationTimeoutMs;
    do{if(failed)throw new ControlError('BROWSER_START_FAILED','独立浏览器启动失败');const current=this.address();if(current){try{return await attach(current);}catch{}}await new Promise(r=>setTimeout(r,150));}while(Date.now()<until);
    throw new ControlError('BROWSER_START_FAILED','独立浏览器调试连接未就绪；请检查专用资料目录是否被其他浏览器占用');
  }
}
