import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {ControlError, checkAbort} from './common.js';

export class Native {
  constructor(timeout = 30000) { this.timeout = timeout; this.pending = new Map(); this.serial = 0; }
  get running() { return !!this.child; }
  start() {
    if (this.child) return;
    if (process.platform !== 'win32') throw new ControlError('PLATFORM_UNSUPPORTED', '桌面控制需要 Windows');
    const script = fileURLToPath(new URL('../native/host.ps1', import.meta.url));
    const child = spawn(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.child = child; this.stderr = '';
    child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000); });
    createInterface({input: child.stdout}).on('line', line => {
      let response; try { response = JSON.parse(line); } catch { return; }
      if (response.event === 'escape') { if (this.child === child) this.onEscape?.(); return; }
      if (response.event === 'takeover') { if (this.child === child) this.onTakeover?.(response); return; }
      if (response.event === 'consent') { if(this.child===child)this.onConsent?.(response);return; }
      if (response.event === 'ui-change') {if(this.child===child)this.onUIChange?.(response);return;}
      if (response.event === 'focus-change') {if(this.child===child)this.onFocusChange?.(response);return;}
      const waiter = this.pending.get(response.id); if (!waiter) return;
      if (response.ok) waiter.resolve(response.data);
      else waiter.reject(new ControlError(response.code ?? 'NATIVE_ERROR', response.error));
    });
    const fail = () => {
      if (this.child === child) this.child = undefined;
      for (const waiter of this.pending.values()) if (waiter.child === child) waiter.reject(new ControlError('NATIVE_EXIT', `桌面服务退出 ${this.stderr}`));
    };
    child.on('error', fail); child.on('exit', fail);
  }
  cancel(child) {
    if (!child) return;
    if (this.child === child) this.child = undefined;
    // The helper's dedicated reader releases only keys/buttons it injected.
    // Give it time to do so before terminating a blocked UIA provider.
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({action: 'cancel'}) + '\n', () => {});
    setTimeout(() => child.kill(), 250);
  }
  async call(action, args = {}, signal) {
    checkAbort(signal); this.start();
    const id = ++this.serial;
    const child = this.child;
    return await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const done = value => { cleanup(); resolve(value); };
      const fail = error => { cleanup(); reject(error); };
      const abort = () => { this.cancel(child); fail(new ControlError('CANCELLED', '操作中止；未确认的动作不可自动重放')); };
      const timer = setTimeout(() => { this.cancel(child); fail(new ControlError('NATIVE_TIMEOUT', '桌面操作超时，未确认的动作不可自动重放')); }, this.timeout);
      this.pending.set(id, {resolve: done, reject: fail, child: this.child});
      signal?.addEventListener('abort', abort, {once: true});
      child.stdin.write(JSON.stringify({...args, id, action}) + '\n', error => { if (error) fail(error); });
    });
  }
  async dispose() {
    if (!this.child) return;
    try { await this.call('shutdown'); } catch { /* process may already be gone */ }
    this.child?.kill(); this.child = undefined;
  }
}
