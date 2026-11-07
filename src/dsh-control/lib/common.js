export class ControlError extends Error {
  constructor(code, message) { super(message); this.name = 'ControlError'; this.code = code; }
}
export function checkAbort(signal) {
  if (signal?.aborted) throw new ControlError('CANCELLED', '操作已中止');
}
export async function abortable(operation, signal, cleanup = () => {}) {
  checkAbort(signal);
  let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => { Promise.resolve().then(cleanup).catch(() => {}); reject(new ControlError('CANCELLED', '操作已中止或超时')); };
    signal.addEventListener('abort', listener, {once: true});
  });
  try { return await Promise.race([Promise.resolve().then(operation), cancelled]); }
  finally { signal.removeEventListener('abort', listener); }
}
export function integer(value, label, min = -2147483648, max = 2147483647) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ControlError('INVALID_ARGUMENT', `${label} 必须是 ${min}..${max} 的整数`);
  return value;
}
export function ownerOf(exec) {
  const id = exec?.agent?.session?.id ?? exec?.agent?.id;
  if (!id) throw new ControlError('SESSION_REQUIRED', '需要拥有此调用的 DSH 会话');
  return String(id);
}
export class Coordinator {
  #active;
  get status() { return this.#active ? {owner: this.#active.owner, action: this.#active.action} : {owner: null}; }
  async run(owner, action, signal, body) {
    checkAbort(signal);
    if (this.#active) throw new ControlError('CONTROL_BUSY', `当前正在执行 ${this.#active.action}，所属会话 ${this.#active.owner}`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    this.#active = {owner, action, controller};
    try { return await body(controller.signal); }
    finally { signal?.removeEventListener('abort', abort); this.#active = undefined; }
  }
  stop(owner) {
    if (this.#active && this.#active.owner !== owner) throw new ControlError('NOT_OWNER', '只能停止本会话的操作');
    this.#active?.controller.abort();
  }
  dispose() { this.#active?.controller.abort(); }
}
export class Observations {
  #items = new Map();
  constructor(maxAge = 60000, limit = 128, clock = Date.now) { this.maxAge = maxAge; this.limit = limit; this.clock=clock; }
  add(owner, value) {
    const id = crypto.randomUUID();
    this.#items.set(id, {owner, at: this.clock(), value});
    while (this.#items.size > this.limit) this.#items.delete(this.#items.keys().next().value);
    return id;
  }
  get(owner, id, kind,allowChanged=false) {
    const item = this.#items.get(id);
    if (!item || item.owner !== owner || item.value.kind !== kind) throw new ControlError('INVALID_OBSERVATION', '先在本会话观察目标，再引用返回的 observationId');
    if (this.clock() - item.at > this.maxAge) throw new ControlError('STALE_OBSERVATION', '观察已过期，请重新观察');
    if(item.invalid&&!allowChanged)throw new ControlError('UI_CHANGED','界面已改变，此观察已失效，请重新观察；不能自动重放输入');
    return item.value;
  }
  forRevalidation(owner,id,maxAge) {
    integer(maxAge,'revalidation age',1,1800000);
    const item=this.#items.get(id);
    if(!item||item.owner!==owner||item.value.kind!=='browser')throw new ControlError('INVALID_OBSERVATION','只能重新核验本会话的浏览器观察');
    const ageMs=this.clock()-item.at,limit=Math.max(this.maxAge,maxAge);
    if(ageMs>limit)throw new ControlError('STALE_OBSERVATION',`观察已超过重新核验上限（${Math.round(ageMs/1000)} 秒），请重新观察`);
    // This is not renewal: one exact live target must still be validated.
    return {value:item.value,ageMs,expired:ageMs>this.maxAge};
  }
  dropBrowserTab(tabId){for(const [id,item] of this.#items)if(item.value.kind==='browser'&&item.value.tabId===tabId)this.#items.delete(id);}
  invalidate(kind,change){
    for(const item of this.#items.values()){
      const v=item.value;if(v.kind!==kind)continue;
      const exact=kind==='desktop'&&Array.isArray(change.nativeObservations);
      const matches=exact?change.nativeObservations.includes(v.nativeObservation):kind==='desktop'?(v.windowId===change.windowId||v.scope==='screen'&&v.windows?.some(w=>w.windowId===change.windowId)):v.tabId===change.tabId&&(!change.sourceId||v.uiSourceId===change.sourceId);
      if(matches&&(exact||change.version===undefined||v.uiVersion===undefined||v.uiVersion<change.version))item.invalid=true;
    }
  }
  invalidateFocus(windowId){for(const item of this.#items.values()){const v=item.value;if(v.kind==='desktop'&&v.scope==='screen'&&v.foregroundWindowId!==windowId)item.invalid=true;}}
}
