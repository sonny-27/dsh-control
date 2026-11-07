window.__ModuleLoader__.load({
  id: 'dsh-agent-supervisor',
  factory(require) {
    const React = require('react')
    const UI = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement, TAB = 'agent-supervisor-list'
    const labels = { running: '运行中', stopping: '正在停止', completed: '已完成', error: '错误', blocked: '受阻', stopped: '已中止', waiting: '等待', unknown: '状态未知' }
    const stores = new Map()
    const css = `
      .das,.das *{box-sizing:border-box;letter-spacing:0}
      .das{color:var(--dsw-alias-label-primary,#202528);font-size:12px;line-height:1.5;min-width:0}
      .das-panel{height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-specific-bg-l1,#fff)}
      .das-toolbar{display:flex;align-items:center;gap:8px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l2,#e2e7e6);flex-wrap:wrap}
      .das-toolbar h3{font-size:14px;margin:0;flex:1;min-width:70px}
      .das-icon{width:28px;height:28px;flex:0 0 28px;border:1px solid var(--dsw-alias-border-l2,#dce2e0);border-radius:4px;color:inherit;background:transparent;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:4px}
      .das-icon:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f5f4)}
      .das-icon:disabled{opacity:.4;cursor:default}
      .das-search{width:100%;height:32px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,#dce2e0);border-radius:4px;background:transparent;color:inherit;font:inherit}
      .das-options{display:flex;align-items:center;gap:12px;flex-wrap:wrap;width:100%;color:var(--dsw-alias-label-secondary,#5e6866)}
      .das-options label{display:inline-flex;align-items:center;gap:5px}
      .das-options input{margin:0;accent-color:#16804b}
      .das-stats{padding:8px 12px;color:var(--dsw-alias-label-secondary,#5e6866);display:flex;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l2,#e2e7e6);font-variant-numeric:tabular-nums}
      .das-notice{padding:8px 12px;overflow-wrap:anywhere;border-bottom:1px solid var(--dsw-alias-border-l2,#e2e7e6);color:var(--dsw-alias-label-secondary,#5e6866)}
      .das-notice[role=alert]{color:#b62939;background:var(--dsw-specific-bg-l2,#fff7f7)}
      .das-list{overflow:auto;flex:1;min-height:0;overscroll-behavior:contain}
      .das-row{padding:12px;border-bottom:1px solid var(--dsw-alias-border-l2,#e2e7e6);min-width:0}
      .das-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f6f8f7)}
      .das-row-head{display:flex;align-items:flex-start;gap:8px;min-width:0}
      .das-open{display:flex;align-items:flex-start;gap:8px;min-width:0;flex:1;text-align:left;border:0;background:transparent;color:inherit;padding:0;font:inherit;cursor:pointer}
      .das-open:disabled{cursor:default}
      .das-open:focus-visible,.das-icon:focus-visible,.das-indicator:focus-visible{outline:2px solid #4378af;outline-offset:3px}
      .das-dot{width:8px;height:8px;border-radius:50%;flex:0 0 8px;background:#89928e;display:inline-block;margin-top:5px}
      .das-dot.running,.das-dot.completed{background:#168d49}
      .das-dot.running{animation:das-pulse 1.25s ease-in-out infinite}
      .das-dot.error{background:#cc3045}
      .das-dot.stopping,.das-dot.blocked{background:#b27720}
      .das-title{font-weight:600;overflow-wrap:anywhere;min-width:0;flex:1}
      .das-state{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary,#64706b);margin-left:auto;padding-top:1px}
      .das-task{margin:6px 0 8px 16px;color:var(--dsw-alias-label-secondary,#5e6866);overflow-wrap:anywhere;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      .das-model{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 8px;margin:5px 0 0 16px;font-size:11px;min-width:0;color:var(--dsw-alias-label-tertiary,#78837d);overflow-wrap:anywhere}
      .das-model-name{color:var(--dsw-alias-label-secondary,#43565f);font-weight:500;min-width:0;overflow-wrap:anywhere}
      .das-model span{min-width:0;overflow-wrap:anywhere}
      .das-progress-line{display:flex;gap:10px;align-items:center;margin-left:16px;min-width:0}
      .das-progress-line progress{flex:1;width:40px;min-width:40px;height:6px;appearance:none;border:0;border-radius:2px;overflow:hidden;background:#e3e9e7;accent-color:#447da6}
      .das-progress-line progress::-webkit-progress-bar{background:var(--dsw-alias-border-l2,#e3e9e7)}
      .das-progress-line progress::-webkit-progress-value{background:#447da6}
      .das-progress-line progress::-moz-progress-bar{background:#447da6}
      .das-progress-label{color:var(--dsw-alias-label-secondary,#64706b);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
      .das-progress-unknown{height:6px;background:var(--dsw-alias-border-l2,#e3e9e7);flex:1;border-radius:2px}
      .das-plan{margin:8px 0 0 16px;color:var(--dsw-alias-label-secondary,#5e6866);min-width:0}
      .das-plan summary{cursor:pointer;font-size:11px;width:fit-content}
      .das-plan ol{list-style:none;margin:8px 0 0;padding:0}
      .das-plan li{display:flex;align-items:flex-start;gap:6px;margin:5px 0;overflow-wrap:anywhere}
      .das-plan li>span:last-child{min-width:0;flex:1}
      .das-plan input{accent-color:#168d49;margin:3px 0 0;flex:none}
      .das-plan .das-dot{width:6px;height:6px;flex-basis:6px;margin:6px 3px 0}
      .das-latest,.das-error,.das-lineage{margin:7px 0 0 16px;font-size:11px;overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary,#78837d)}
      .das-error{color:#bd2f40}
      .das-empty{padding:28px 16px;text-align:center;color:var(--dsw-alias-label-tertiary,#78837d)}
      .das-footer{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l2,#e2e7e6);display:flex;align-items:center;gap:8px;justify-content:space-between}
      .das-footer button{font:inherit;background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l2,#dce2e0);border-radius:4px;padding:4px 8px;cursor:pointer}
      .das-footer button:disabled{opacity:.4;cursor:default}
      .das-indicator{background:transparent;color:inherit;border:0;padding:3px 5px;display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;min-height:28px;max-width:100%;cursor:pointer;border-radius:4px;font-variant-numeric:tabular-nums}
      .das-indicator>span:last-child{white-space:normal;text-align:left;overflow-wrap:anywhere;min-width:0}
      .das-indicator:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f5f4)}
      .das-indicator .das-dot{margin:0}
      .das-dock{display:flex;align-items:center;gap:6px;min-width:0;padding:3px 0;flex-wrap:wrap}
      .das-dock .das-spacer{flex:1;min-width:0}
      .das-dock-note{color:var(--dsw-alias-label-tertiary,#78837d);font-size:11px;overflow-wrap:anywhere;min-width:0}
      @keyframes das-pulse{0%,100%{opacity:1}50%{opacity:.25}}
      @media(prefers-reduced-motion:reduce){.das-dot.running{animation:none}}
      @media(max-width:380px){.das-toolbar,.das-row{padding:10px}.das-progress-label{font-size:10px}.das-state{font-size:10px}.das-stats{gap:8px}}
    `
    function nativeAddress(entry) {
      if (!entry?.openable || !entry.id || !entry.parentId || !['one-shot', 'continuable', 'unknown'].includes(entry.mode)) throw new Error('子代理地址不可用')
      return 'dsh-resource://subagentchat/session/' + encodeURIComponent(entry.id) + '?' + new URLSearchParams({ parent: entry.parentId, mode: entry.mode })
    }
    function openChild(ctx, entry) {
      if (!ctx.sidebarRight?.openResource) throw new Error('原生子代理侧栏接口不可用')
      ctx.sidebarRight.openResource(nativeAddress(entry), { kind: 'subagentchat', preferNewPane: false })
    }
    function createStore(rootId) {
      let value = { data: null, loading: true, error: '', actionError: '', busy: false, cascadePending: null }, listeners = new Set(), controller, timer, disposed = false
      const publish = patch => { value = { ...value, ...patch }; for (const listener of listeners) listener() }
      async function request(url, options = {}) {
        const response = await fetch(url, { credentials: 'same-origin', ...options })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || '会话状态暂不可用')
        if (body.rootId !== rootId) throw new Error('返回的会话归属不匹配')
        return body
      }
      async function poll(force = false) {
        clearTimeout(timer)
        controller?.abort()
        controller = new AbortController()
        const own = controller
        try {
          const data = await request('/api/dsh-agent-supervisor/state?root=' + encodeURIComponent(rootId) + (force ? '&refresh=1' : ''), { signal: own.signal })
          if (!own.signal.aborted && !disposed) publish({ data, loading: false, error: '' })
        } catch (error) { if (!own.signal.aborted && !disposed) publish({ loading: false, error: String(error.message ?? error) }) }
        finally { if (!disposed && !value.busy && listeners.size && controller === own) timer = setTimeout(() => void poll(), 2000) }
      }
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) void poll()
          return () => { listeners.delete(listener); if (!listeners.size) { clearTimeout(timer); controller?.abort() } }
        },
        refresh: () => poll(true),
        async control(payload) {
          if (value.busy) return
          clearTimeout(timer); controller?.abort(); publish({ busy: true, actionError: '', cascadePending: payload.action === 'options' ? payload.cascade : null })
          try {
            const data = await request('/api/dsh-agent-supervisor/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, rootId }) })
            if (!disposed) publish({ data, loading: false, error: '' })
            if (data.result?.failures?.length) throw new Error(data.result.failures.length + ' 个代理未能确认停止')
          } catch (error) { if (!disposed) publish({ actionError: String(error.message ?? error) }) }
          finally { if (!disposed) { publish({ busy: false, cascadePending: null }); if (listeners.size) void poll() } }
        },
        dispose() { disposed = true; clearTimeout(timer); controller?.abort(); listeners.clear() },
      }
    }
    function useStateFor(rootId) {
      const store = React.useMemo(() => {
        if (!rootId) return null
        if (!stores.has(rootId)) stores.set(rootId, createStore(rootId))
        return stores.get(rootId)
      }, [rootId])
      const empty = React.useMemo(() => ({ data: null, loading: false, error: '', busy: false }), [])
      const value = React.useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSnapshot ?? (() => empty))
      return { ...value, store }
    }
    function IconButton({ icon, title, onClick, disabled }) {
      return h('button', { type: 'button', className: 'das-icon', title, 'aria-label': title, onClick, disabled }, h(icon, { size: 16 }))
    }
    function Dot({ status }) { return h('span', { className: 'das-dot ' + status, 'aria-hidden': true }) }
    function resumeTitle(data) { return data?.paused?.id !== data?.rootId ? '解除上级任务树暂停，不自动开始任务' : '解除暂停，不自动开始任务' }
    function statusLabel(item) { return item.statusPending ? '同步中' : labels[item.status] ?? labels.unknown }
    function Panel({ ctx, sessionId }) {
      const { data, loading, error, actionError, busy, cascadePending, store } = useStateFor(sessionId)
      const [query, setQuery] = React.useState(''), [onlyRunning, setOnlyRunning] = React.useState(false), [page, setPage] = React.useState(0), [openError, setOpenError] = React.useState('')
      React.useEffect(() => { setPage(0); setOpenError('') }, [sessionId, query, onlyRunning])
      const modelHostOutdated = !!data && data.apiVersion !== 1
      const entries = (data?.entries ?? []).filter(item => (!onlyRunning || item.status === 'running' || item.status === 'stopping' || item.statusPending) && (item.label + ' ' + item.task + ' ' + item.id + ' ' + (item.model?.id ?? '') + ' ' + (item.model?.provider ?? '') + ' ' + (item.model?.reasoningEffort ?? '')).toLowerCase().includes(query.toLowerCase()))
      const pages = Math.max(1, Math.ceil(entries.length / 80)), selectedPage = Math.min(page, pages - 1)
      const open = item => { try { openChild(ctx, item); setOpenError('') } catch (failure) { setOpenError(String(failure.message ?? failure)) } }
      return h('section', { className: 'das das-panel', 'aria-label': '子代理任务列表' },
        h('div', { className: 'das-toolbar' }, h('h3', null, '子代理'),
          h(IconButton, { icon: UI.IconRefreshOutlineRegular, title: '刷新子代理', disabled: busy || !store, onClick: () => void store.refresh() }),
          data?.paused ? h(IconButton, { icon: UI.IconPlayOutlineRegular, title: resumeTitle(data), disabled: busy, onClick: () => void store.control({ action: 'resume', token: data.paused.token }) }) : null,
          h('input', { className: 'das-search', type: 'search', 'aria-label': '搜索子代理', placeholder: '搜索任务、代理或模型', value: query, onChange: event => setQuery(event.target.value) }),
          h('div', { className: 'das-options' },
            h('label', null, h('input', { type: 'checkbox', checked: onlyRunning, onChange: event => setOnlyRunning(event.target.checked) }), '仅运行中'),
            h('label', null, h('input', { type: 'checkbox', 'aria-label': '主会话停止时联动子代理', checked: cascadePending ?? data?.cascade ?? true, disabled: busy || !data, onChange: event => void store.control({ action: 'options', cascade: event.target.checked }) }), '联动停止'))),
        data ? h('div', { className: 'das-stats' }, h('span', null, '运行 ', data.counts.running), data.counts.stopping ? h('span', null, '停止中 ', data.counts.stopping) : null, h('span', null, '完成 ', data.counts.completed), h('span', null, '错误 ', data.counts.error), h('span', null, '全部 ', data.truncated ? '≥' : '', data.counts.total)) : null,
        error || actionError || openError ? h('div', { className: 'das-notice', role: 'alert' }, error || actionError || openError, error && data ? ' · 显示上次状态' : '') : null,
        modelHostOutdated ? h('div', { className: 'das-notice', role: 'alert' }, '模型显示更新尚未由宿主加载') : null,
        data?.persistenceError ? h('div', { className: 'das-notice', role: 'alert' }, '暂停状态保存失败：', data.persistenceError) : null,
        data?.paused ? h('div', { className: 'das-notice', role: 'status' }, data.paused.id === data.rootId ? '任务树已暂停' : '上级任务树已暂停', data.counts.stopping ? ' · ' + data.counts.stopping + ' 个仍在停止' : '') : null,
        data?.truncated ? h('div', { className: 'das-notice' }, '已达到本次读取上限，数量为下限') : null,
        data?.warnings?.length ? h('div', { className: 'das-notice' }, data.warnings.length + ' 项目录归属异常已排除') : null,
        h('div', { className: 'das-list' }, loading && !data ? h('div', { className: 'das-empty', role: 'status' }, '正在读取子代理') : !sessionId ? h('div', { className: 'das-empty' }, '当前没有打开的会话') : !entries.length ? h('div', { className: 'das-empty' }, query || onlyRunning ? '没有匹配的子代理' : '暂无子代理') : entries.slice(selectedPage * 80, selectedPage * 80 + 80).map(item =>
          h('article', { className: 'das-row', key: item.id, 'data-agent-id': item.id, 'data-status': item.status },
            h('div', { className: 'das-row-head' },
              h('button', { type: 'button', className: 'das-open', title: '在右侧栏打开 ' + item.label, 'aria-label': '打开子代理 ' + item.label, disabled: !item.openable, onClick: () => open(item) }, h(Dot, { status: item.status }), h('span', { className: 'das-title' }, item.label), h('span', { className: 'das-state', title:item.statusDetail }, statusLabel(item)))),
            item.statusDetail && (item.statusPending || item.status==='stopped' || item.status==='stopping') ? h('div',{className:'das-latest'},item.statusDetail,Number.isFinite(item.statusAt)&&item.statusAt>0?' · '+new Date(item.statusAt).toLocaleTimeString():'') : null,
            h('div', { className: 'das-model', 'aria-label': '模型信息', title: item.model?.source === 'request' ? '子代理自身最近一次解析后的请求模型' : item.model ? '子代理自身配置，尚无请求记录' : '没有可核验的子代理模型信息' },
              h('span', { className: 'das-model-name' }, item.model?.id ?? (modelHostOutdated ? '宿主待更新' : '模型未知')),
              item.model?.reasoningEffort ? h('span', null, item.model.reasoningEffort) : null,
              item.model ? h('span', null, item.model.provider || '供应商未知') : null,
              item.model?.source === 'configured' ? h('span', null, '配置') : null),
            h('p', { className: 'das-task', title: item.task }, item.task),
            h('div', { className: 'das-progress-line' }, item.plan ? h('progress', { max: 100, value: item.plan.percent, 'aria-label': item.label + ' 计划进度', 'aria-valuetext': item.plan.completed + '/' + item.plan.total + ' 已完成' }) : h('div', { className: 'das-progress-unknown', 'aria-hidden': true }),
              h('span', { className: 'das-progress-label' }, item.plan ? item.plan.completed + '/' + item.plan.total + ' · ' + item.plan.percent + '%' + (item.plan.previousTurn ? ' · 上轮' : '') : '未提交计划')),
            item.plan ? h('details', { className: 'das-plan' }, h('summary', null, 'Plan'), h('ol', null, item.plan.items.map((step, index) => h('li', { key: index },
              step.status === 'in_progress' ? h(Dot, { status: item.status === 'running' ? 'running' : 'waiting' }) : h('input', { type: 'checkbox', checked: step.status === 'completed', disabled: true, 'aria-label': step.status === 'completed' ? '已完成' : '未开始', readOnly: true }), h('span', null, step.content))), item.plan.truncated ? h('li', null, '仅展开前 200 项') : null)) : null,
            item.latest ? h('div', { className: 'das-latest', title: item.latest }, item.latest) : null,
            item.error ? h('div', { className: 'das-error' }, item.error) : null,
            item.depth > 1 ? h('div', { className: 'das-lineage', title: item.parentId }, '第 ', item.depth, ' 级 · ', item.parentLabel ?? item.parentId) : null))),
        pages > 1 ? h('div', { className: 'das-footer' }, h('button', { type: 'button', disabled: selectedPage === 0, onClick: () => setPage(selectedPage - 1) }, '上一页'), h('span', null, selectedPage + 1, ' / ', pages), h('button', { type: 'button', disabled: selectedPage + 1 >= pages, onClick: () => setPage(selectedPage + 1) }, '下一页')) : null)
    }
    function Indicator({ ctx, sessionId, dock = false }) {
      const { data, loading, error, busy, store } = useStateFor(sessionId)
      if (!sessionId || !data && !error || !error && !data.paused && data.counts.total === 0) return null
      const status = error ? 'unknown' : data.counts.running > 0 ? 'running' : data.counts.stopping > 0 ? 'stopping' : data.counts.error > 0 ? 'error' : data.counts.total > 0 && data.counts.completed === data.counts.total ? 'completed' : 'waiting'
      const text = error ? '子代理状态未知' : '子代理 ' + data.counts.running + ' 运行中' + (data.counts.stopping ? ' · ' + data.counts.stopping + ' 停止中' : '') + (data.counts.unknown ? ' · ' + data.counts.unknown + ' 未知' : '') + ' / ' + (data.truncated ? '≥' : '') + data.counts.total
      return h('div', { className: 'das' + (dock ? ' das-dock' : '') },
        h('button', { type: 'button', className: 'das-indicator', title: error || '打开子代理任务列表', 'aria-label': text, onClick: () => ctx.sidebarRight.openTab(TAB) }, h(Dot, { status }), h('span', null, text)),
        dock ? h('span', { className: 'das-spacer' }) : null,
        dock && data?.paused ? h('span', { className: 'das-dock-note' }, data.paused.id === data.rootId ? '任务树已暂停' : '上级任务树已暂停') : null,
        dock && data?.paused ? h(IconButton, { icon: UI.IconPlayOutlineRegular, title: resumeTitle(data), disabled: busy, onClick: () => void store.control({ action: 'resume', token: data.paused.token }) }) : null)
    }
    function apply(ctx) {
      ctx.effect(() => { const style = document.createElement('style'); style.dataset.agentSupervisor = 'true'; style.textContent = css; document.head.appendChild(style); return () => { style.remove(); for (const store of stores.values()) store.dispose(); stores.clear() } })
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB, kind: TAB, priority: 'extension', title: () => '子代理', guide: [{ order: 28, title: () => '子代理任务', icon: props => h(UI.IconFolderOpenRegular, props) }] }))
      ctx.slots.inject('sidebar.right.pane.tab', function* () { yield ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB, inject: sessionId => ({ ctx, sessionId }) }, Panel) })
      ctx.slots.inject('sidebar.right.pane.tab.title', function* () { yield ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB }, () => h('span', null, '子代理')) })
      ctx.slots.inject('conversation.input.dock', function* () { yield ctx.slots.register({ name: 'conversation.input.dock', id: 'agent-supervisor-dock', order: 25, inject: sessionId => ({ ctx, sessionId, dock: true }) }, Indicator) })
    }
    return { apply, inject: ['slots', 'sessions', 'sidebarRight', 'sidebarRightTabs'], Panel, Indicator, nativeAddress, openChild, createStore, statusLabel, css }
  },
})
