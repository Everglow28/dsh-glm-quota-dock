// Client half of the GLM quota dock bundle.
//
// Registers a pill into `conversation.composer.dock` (the row that carries the
// session statistics and context meter). The pill polls the package's own
// authenticated /api/glm-quota route (same-origin; the browser session cookie
// authenticates it) and shows the highest quota percentage, colored by
// threshold; clicking it opens a detail panel with every limit, reset times,
// and a manual refresh.
window.__ModuleLoader__.load({
  id: 'dsh-glm-quota-dock',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'glm-quota-dock';
    const POLL_MS = 30_000;
    const IDLE_AFTER_MS = 5 * 60_000;  // no key/pointer/wheel input for 5 min → idle
    const IDLE_POLL_MS = 5 * 60_000;   // idle re-poll cadence

    // This plugin's own version (kept in sync with package.json by hand; the
    // client bundle cannot read package.json at runtime). Shown as muted "v"
    // text in the panel footer — deliberately unlike the plan-tier badge.
    const PLUGIN_VERSION = '1.3.1';
    const NPM_PACKAGE = 'dsh-glm-quota-dock';
    const UPDATE_CHECK_MS = 60 * 60_000; // re-check npm for a newer release hourly
    let updateCheck = { at: 0, latest: null }; // module-level: shared across mounts

    const DICTS = {
      zh: {
        tokensBase: 'Token 额度',
        toolsBase: '工具调用额度',
        creditsBase: '积分额度',
        unitHour: '小时',
        unitWeek: '周',
        unitMonth: '月',
        unitDay: '天',
        resetIn: '重置',
        today: '今日',
        refresh: '刷新',
        loading: '读取中…',
        error: '额度获取失败',
        stale: '数据过期',
        cachedPrefix: '缓存于',
        usage24h: '近 24 小时 Token',
        calls: '次调用',
        usagePage: '在浏览器中打开用量页',
        newVersion: '可更新',
        confirmUpdate: '更新插件到 {v}?',
        cancel: '取消',
        confirm: '更新',
        updating: '更新中…',
        updateFailed: '更新失败',
        updateDone: '已更新,刷新页面',
        absUsage: '已用 {a}/{b} · 剩余 {c}',
        sparkTip: '{range} · 峰值 {peak} token · {calls} 次调用',
        planTipSuffix: '。当前档位:',
        seg5h: '5h',
        segWeek: '周',
        segTool: '工具',
        planDescV1: '历史版本 V1:5 小时滚动 Token 窗口 + 月度工具调用额度',
        planDescV2: '历史版本 V2:Token 窗口制,含每周窗口',
        planDescCredit: '新版积分套餐:按 Token 消耗积分抵扣',
      },
      en: {
        tokensBase: 'Token quota',
        toolsBase: 'Tool quota',
        creditsBase: 'Credit quota',
        unitHour: 'h',
        unitWeek: 'wk',
        unitMonth: 'mo',
        unitDay: 'd',
        resetIn: 'resets',
        today: '',
        refresh: 'Refresh',
        loading: 'Loading…',
        error: 'Quota unavailable',
        stale: 'stale',
        cachedPrefix: 'cached',
        usage24h: 'Tokens (last 24h)',
        calls: 'calls',
        usagePage: 'Open usage page in browser',
        newVersion: 'Update',
        confirmUpdate: 'Update plugin to {v}?',
        cancel: 'Cancel',
        confirm: 'Update',
        updating: 'Updating…',
        updateFailed: 'Update failed',
        updateDone: 'Updated, reloading',
        absUsage: '{a}/{b} used · {c} left',
        sparkTip: '{range} · peak {peak} tokens · {calls} calls',
        planTipSuffix: '. Current tier: ',
        seg5h: '5h',
        segWeek: 'wk',
        segTool: 'tool',
        planDescV1: 'Legacy V1: 5-hour rolling token window + monthly tool quota',
        planDescV2: 'Legacy V2: token windows including a weekly window',
        planDescCredit: 'New credit plan: token usage draws credits',
      },
    };

    const CSS = [
      ".glmq-root{box-sizing:border-box;min-width:0;max-width:100%;position:relative;display:inline-flex;order:1}",
      ".glmq-pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}",
      ".glmq-pill:hover,.glmq-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
      ".glmq-pill svg{flex:none;width:14px;height:14px}",
      ".glmq-mark{display:inline-flex;align-items:center;color:var(--dsw-alias-brand-primary)}",
      ".glmq-mark svg{display:block}",
      ".glmq-pct{color:var(--glmq-state,var(--dsw-alias-label-secondary));font-weight:600}",
      ".glmq-panel{position:absolute;bottom:calc(100% + 10px);left:50%;transform:translateX(-50%);z-index:30;width:360px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);border:0.5px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.10),0 12px 40px rgba(0,0,0,.12);padding:14px;display:flex;flex-direction:column;gap:12px;text-align:left}",
      ".glmq-panel-head{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600}",
      ".glmq-panel-head svg{flex:none;width:15px;height:15px;color:#0b7fff}",
      ".glmq-refresh{margin-left:auto;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:2px;border-radius:6px;display:inline-flex}",
      ".glmq-refresh:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".glmq-refresh svg{width:13px;height:13px}",
      ".glmq-extlink{margin-left:auto;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:2px;border-radius:6px;display:inline-flex;text-decoration:none}",
      ".glmq-extlink:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".glmq-extlink svg{width:13px;height:13px}",
      ".glmq-spacer{flex:1}",
      ".glmq-plan-tag{cursor:help;position:relative;font-size:10px;font-weight:600;color:#0b7fff;background:color-mix(in srgb,#0b7fff 10%,transparent);border-radius:999px;padding:1px 7px;letter-spacing:.02em;font-weight:600}",
      ".glmq-plan-tag::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%) translateY(2px);width:max-content;max-width:224px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);border:0.5px solid var(--dsw-alias-border-l1);border-radius:9px;box-shadow:0 4px 16px rgba(0,0,0,.10),0 12px 40px rgba(0,0,0,.12);padding:8px 10px;font-size:11px;font-weight:400;line-height:1.65;text-align:left;letter-spacing:normal;white-space:normal;opacity:0;pointer-events:none;transition:opacity .15s ease,transform .15s ease;z-index:40}",
      ".glmq-plan-tag:hover::after{opacity:1;transform:translateX(-50%) translateY(0)}",
      ".glmq-cards{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
      ".glmq-limit-row{display:flex;align-items:baseline;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".glmq-limit-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".glmq-limit{background:var(--dsw-alias-interactive-bg-hover);border-radius:10px;padding:9px 10px;display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".glmq-limit-head{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-primary);min-width:0}",
      ".glmq-limit-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".glmq-limit-big{display:flex;align-items:baseline;gap:6px}",
      ".glmq-limit-value{font-size:17px;line-height:1.1;font-weight:700;font-variant-numeric:tabular-nums}",
      ".glmq-limit-time{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".glmq-bar{height:5px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}",
      ".glmq-bar-fill{height:100%;border-radius:999px;background:var(--glmq-state,var(--dsw-alias-state-success-primary));transition:width .2s ease}",
      ".glmq-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
      ".glmq-reset{display:inline-flex;align-items:center;gap:4px;color:var(--glmq-state,var(--dsw-alias-label-tertiary))}",
      ".glmq-reset svg{width:11px;height:11px;flex:none}",
      ".glmq-reset .glmq-hhmm{font-variant-numeric:tabular-nums}",
      ".glmq-panel-foot{display:flex;align-items:center;gap:6px;white-space:nowrap;border-top:0.5px solid var(--dsw-alias-border-l1);padding-top:10px;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
      ".glmq-panel-foot>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}",
      ".glmq-ver{flex:none;color:var(--dsw-alias-label-tertiary)}",
      ".glmq-upd{flex:none;border:none;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);padding:1px 8px;border-radius:999px;font:inherit;font-size:10px;font-weight:600;color:var(--dsw-alias-state-success-primary);cursor:pointer;text-decoration:none}",
      ".glmq-upd:hover{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 22%,transparent)}",
      ".glmq-upd-busy{opacity:.6;pointer-events:none}",
      ".glmq-upd-fail{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}",
      ".glmq-upd-wrap{position:relative;flex:none;display:inline-flex}",
      ".glmq-confirm{position:absolute;bottom:calc(100% + 10px);right:0;z-index:40;width:216px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);border:0.5px solid var(--dsw-alias-border-l1);border-radius:11px;box-shadow:0 4px 16px rgba(0,0,0,.10),0 12px 40px rgba(0,0,0,.12);padding:11px 12px;text-align:left;white-space:normal}",
      ".glmq-confirm-text{font-size:11.5px;color:var(--dsw-alias-label-primary);line-height:1.5}",
      ".glmq-confirm-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:9px}",
      ".glmq-btn{border:none;border-radius:8px;padding:3px 10px;font:inherit;font-size:11px;font-weight:600;cursor:pointer}",
      ".glmq-btn-ghost{background:0 0;color:var(--dsw-alias-label-secondary)}",
      ".glmq-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".glmq-btn-go{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-on-accent,#fff)}",
      ".glmq-btn-go:hover{filter:brightness(1.08)}",
      ".glmq-seg{display:inline-flex;align-items:center;gap:3px}",
      ".glmq-seg-label{color:var(--dsw-alias-label-secondary)}",
      ".glmq-sep{margin:0 4px;color:var(--dsw-alias-separator-primary,var(--dsw-alias-label-tertiary))}",
      ".glmq-spark{display:flex;align-items:flex-end;gap:1px;height:26px}",
      ".glmq-spark span{flex:1;min-width:1px;border-radius:1px 1px 0 0;background:#0b7fff;opacity:.85}",
      ".glmq-detail{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".glmq-detail li{display:flex;gap:6px}",
      ".glmq-detail .glmq-detail-usage{margin-left:auto;font-variant-numeric:tabular-nums}",
      ".glmq-usage-toggle{display:flex;align-items:baseline;gap:6px;width:100%;border:none;background:0 0;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;border-radius:7px}",
      ".glmq-usage-toggle:hover .glmq-limit-label,.glmq-usage-toggle:hover .glmq-usage-chev{color:var(--dsw-alias-label-primary)}",
      ".glmq-usage-toggle:focus-visible{outline:1.5px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
      ".glmq-usage-chev{display:inline-flex;flex:none;width:12px;height:12px;margin-left:auto;align-self:center;color:var(--dsw-alias-label-tertiary);transition:transform .18s ease,color .12s ease}",
      ".glmq-usage-chev svg{display:block;width:12px;height:12px}",
      ".glmq-usage-toggle[aria-expanded=true] .glmq-usage-chev{transform:rotate(180deg)}",
      "@media (prefers-reduced-motion:reduce){.glmq-bar-fill{transition:none}.glmq-plan-tag::after{transition:none}.glmq-usage-chev{transition:none}}",
    ].join("");

    const MARK_ICON = h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('circle', { cx: 8, cy: 8, r: 6.2, stroke: 'currentColor', strokeWidth: 1.6, strokeDasharray: '26 13', strokeLinecap: 'round', transform: 'rotate(-90 8 8)' }),
      h('circle', { cx: 8, cy: 8, r: 2.6, fill: 'currentColor' }));

    const REFRESH_ICON = h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M13.3 6.7A5.4 5.4 0 1 0 13.9 9.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('path', { d: 'M13.5 2.5v4h-4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));

    const CLOCK_ICON = h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.5 }),
      h('path', { d: 'M8 4.8V8l2.2 1.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));

    const EXTLINK_ICON = h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M6.5 3.5H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      h('path', { d: 'M9.5 2.5h4v4M13.2 2.8 7.8 8.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));

    const CHEVRON_ICON = h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M4.2 6.2 8 10l3.8-3.8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));

    const USAGE_PAGE_URL = 'https://bigmodel.cn/coding-plan/personal/usage';

    function stateColor(pct) {
      if (pct >= 95) return 'var(--dsw-alias-state-error-primary)';
      if (pct >= 80) return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-state-success-primary)';
    }

    /**
     * Panel card colors, synced with the reference screenshot: accents are
     * assigned by window identity, not response order — the 5h token window is
     * always blue (#0B7FFF), the tool-call window always purple (#9E77ED), the
     * weekly window teal, credits amber, anything else rose. Accents yield to
     * the shared thresholds at ≥80% (warn amber) and ≥95% (critical red),
     * tinting text and bar alike.
     */
    const typeOf = (limit) => String(limit.type || '').toUpperCase();

    function limitAccent(limit, type) {
      const unit = Number(limit.unit);
      if (type.includes('TOKEN')) return '#0b7fff';
      if (type.includes('TIME') || type.includes('TOOL') || type.includes('MCP')) return '#9e77ed';
      if (unit === 4) return '#14b8a6';
      if (type.includes('CREDIT')) return '#f59e0b';
      return '#f43f5e';
    }
    function cardColor(pct, limit, type) {
      if (pct >= 80) return stateColor(pct);
      return limitAccent(limit, type);
    }

    function fmtCompact(value, locale) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '0';
      try {
        return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
      } catch {
        return String(n);
      }
    }

    function resetInfo(nextResetTime, t) {
      const ms = Number(nextResetTime);
      if (!Number.isFinite(ms) || ms <= 0) return null;
      const date = new Date(ms);
      const now = new Date();
      const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
      const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const todayWord = t('today') || '';
      const label = sameDay ? [todayWord, time].filter(Boolean).join(' ') : `${date.getMonth() + 1}-${date.getDate()} ${time}`;
      const deltaMin = Math.round((ms - Date.now()) / 60_000);
      let countdown;
      if (deltaMin <= 0) countdown = '<1m';
      else if (deltaMin < 60) countdown = `${deltaMin}m`;
      else {
        const hours = Math.floor(deltaMin / 60);
        countdown = hours < 24 ? `${hours}h ${deltaMin % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
      }
      return { label, countdown, title: `${t('resetIn')} · ${countdown}` };
    }

    /**
     * Version-proof limit labeling: derive the base word from the type keyword
     * (V1/V2/credit plans) and the window from the unit/number pair observed in
     * the quota/limit response (3=hour 5=month; 4=week for V2 weekly limits),
     * falling back to the raw type for unknown future shapes.
     */
    function limitInfo(limit, t) {
      const type = String(limit.type || '').toUpperCase();
      let base;
      if (type.includes('CREDIT')) base = t('creditsBase');
      else if (type.includes('TOKEN')) base = t('tokensBase');
      else if (type.includes('TIME') || type.includes('TOOL') || type.includes('MCP')) base = t('toolsBase');
      else base = limit.type;
      const n = Number(limit.number);
      const unitWord = { 1: t('unitDay'), 2: t('unitDay'), 3: t('unitHour'), 4: t('unitWeek'), 5: t('unitMonth') }[Number(limit.unit)];
      const win = unitWord && Number.isFinite(n) && n > 0 ? `${n > 1 ? n : ''}${unitWord}` : null;
      return { label: win ? `${base} · ${win}` : base, base, win };
    }

    function useQuotaPoll(enabled) {
      const [state, setState] = React.useState({ phase: 'loading' });
      const [, setBump] = React.useState(0);
      const tickRef = React.useRef(null);
      const enabledRef = React.useRef(enabled);
      // Host 下发的轮询参数(payload.client);未到达前用本地默认值
      const remoteRef = React.useRef(null);
      enabledRef.current = enabled;
      React.useEffect(() => {
        let alive = true;
        let lastFetchAt = 0;
        let lastActivityAt = Date.now();
        let timer = null;
        let currentMs = POLL_MS;
        const idleAfter = () => (remoteRef.current?.idleAfterMs || IDLE_AFTER_MS);
        const idlePoll = () => (remoteRef.current?.idlePollMs || IDLE_POLL_MS);
        const tick = async (force) => {
          if (!enabledRef.current) return;
          lastFetchAt = Date.now();
          try {
            const res = await fetch('/api/glm-quota' + (force ? '?force=1' : ''), { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const json = await res.json();
            if (alive) {
              if (json.client && typeof json.client === 'object') remoteRef.current = json.client;
              applyInterval();
              setState(json.ok ? { phase: 'ok', ...json } : { phase: 'error', error: json.error || 'upstream error' });
            }
          } catch (error) {
            if (alive) setState({ phase: 'error', error: String(error) });
          }
        };
        tickRef.current = tick;
        // Host 下发的 pollMs 与本地不同时重建 interval
        const applyInterval = () => {
          const desired = Number(remoteRef.current?.pollMs);
          if (!Number.isFinite(desired) || desired < 5_000 || desired === currentMs) return;
          currentMs = desired;
          if (timer) clearInterval(timer);
          timer = setInterval(onTick, currentMs);
        };
        const onTick = () => {
          if (document.visibilityState !== 'visible') return;
          setBump((n) => n + 1); // force a render so the projection snapshot is re-read even if a notification was missed
          if (enabledRef.current) {
            if (Date.now() - lastActivityAt < idleAfter()) {
              tick(false);
            } else if (Date.now() - lastFetchAt >= idlePoll()) {
              tick(false); // idle: slow to the Host-specified idle cadence
            }
          }
        };
        tickRef.current = tick;
        if (enabledRef.current) tick(false);
        timer = setInterval(onTick, currentMs);
        const markActivity = () => {
          const wasIdle = Date.now() - lastActivityAt >= idleAfter();
          lastActivityAt = Date.now();
          if (wasIdle && document.visibilityState === 'visible') tick(false);
        };
        const onVisible = () => {
          if (document.visibilityState === 'visible') tick(false);
        };
        const activityEvents = ['keydown', 'pointerdown', 'wheel'];
        for (const name of activityEvents) document.addEventListener(name, markActivity, { passive: true });
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          alive = false;
          clearInterval(timer);
          for (const name of activityEvents) document.removeEventListener(name, markActivity);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [enabled]);
      return [state, (force) => { if (tickRef.current) tickRef.current(force); }];
    }

    /**
     * Card-style limit row (two-column grid): header with the window title
     * (the 5h card additionally shows its live countdown at the right of the
     * header), a large percentage with the reset moment as muted trailing
     * text, and a thick accent-colored progress bar. Per-model usageDetails
     * fold into the hover tooltip instead of taking panel space.
     */
    function LimitRow({ limit, t, isPrimary }) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(limit.percentage) || 0)));
      const info = limitInfo(limit, t);
      const reset = resetInfo(limit.nextResetTime, t);
      const detailLines = Array.isArray(limit.usageDetails) && limit.usageDetails.length > 0
        ? limit.usageDetails.map((entry) => `${entry.modelCode || entry.show_name || '-'}: ${entry.usage ?? 0}`)
        : [];
      // absolute usage counters (call-count style limits carry currentValue /
      // usage / remaining) surface in the tooltip next to the percentage
      const a = Number(limit.currentValue);
      const b = Number(limit.usage);
      const c = Number(limit.remaining);
      const absLine = Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)
        ? String(t('absUsage') || '{a}/{b} · {c}').replace('{a}', a).replace('{b}', b).replace('{c}', c)
        : null;
      const tip = [info.label + (reset ? ` · ${reset.title}` : ''), absLine, ...detailLines].filter(Boolean).join('\n');
      const accent = cardColor(pct, limit, typeOf(limit));
      // the big percentage stays neutral until the shared thresholds
      // (≥80% warn / ≥95% critical) color it with the card accent
      const pctColor = pct >= 80 ? accent : 'var(--dsw-alias-label-primary)';
      const headChildren = [h('span', { className: 'glmq-limit-title', key: 'title' }, info.win || info.base)];
      if (isPrimary && reset) {
        // the 5h window's live countdown sits at the top of its card
        headChildren.push(h('span', { className: 'glmq-limit-time', key: 'countdown' }, reset.countdown));
      }
      return h('div', { className: 'glmq-limit', title: tip },
        h('div', { className: 'glmq-limit-head' }, headChildren),
        h('div', { className: 'glmq-limit-big' },
          h('span', { className: 'glmq-limit-value', style: { color: pctColor } }, pct + '%'),
          reset ? h('span', { className: 'glmq-limit-time' }, reset.label) : null),
        h('div', { className: 'glmq-bar' },
          h('div', { className: 'glmq-bar-fill', style: { width: pct + '%', '--glmq-state': accent } })));
    }

    /**
     * Infer the plan version from the limits shape (the response has no explicit
     * version field): credit-type entries → new credit plan, any weekly window
     * (unit 4) → V2, otherwise the V1 5-hour+monthly pair. Unknown shapes get
     * no badge rather than a wrong one.
     */
    function planInfo(quota, t) {
      const limits = Array.isArray(quota?.limits) ? quota.limits : [];
      if (limits.length === 0) return null;
      const typeOf = (limit) => String(limit.type || '').toUpperCase();
      let desc;
      if (limits.some((limit) => typeOf(limit).includes('CREDIT'))) desc = t('planDescCredit');
      else if (limits.some((limit) => Number(limit.unit) === 4)) desc = t('planDescV2');
      else desc = t('planDescV1');
      return desc;
    }

    function QuotaWidget({ t, loc, useProjection }) {
      // Show only when the session routes through a GLM Coding Plan provider
      // (a coding endpoint whose usage draws on the plan quota) with a glm-*
      // model. Plain-API glm routes bill the prepaid balance and never touch
      // the plan windows, so they must NOT light up the pill. The selection
      // projection is framework-provided to session-scoped slot occupants.
      let selection = null;
      if (typeof useProjection === "function") {
        try {
          selection = useProjection("modelSelection");
        } catch {
          selection = null;
        }
      }
      const selectionNow = selection?.next ?? selection?.lastUsed ?? null;
      const providerId = String(selectionNow?.provider || "").toLowerCase();
      const modelId = String(selectionNow?.model || "").toLowerCase();
      const isCodingPlanRoute = providerId.includes("coding") || providerId.includes("zai-coding");
      const isGlmModel = modelId.startsWith("glm");
      const isGlmSession = !!selectionNow && isCodingPlanRoute && isGlmModel;
      const [state, refresh] = useQuotaPoll(isGlmSession);
      const [open, setOpen] = React.useState(false);
      // 24h usage card starts collapsed (chart/model body unmounted); the
      // choice lives for the page session only, every fresh load collapses again
      const [usageOpen, setUsageOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      // quiet update check: interval comes from the Host config (payload.client),
      // shared module cache; cooldown is set only on SUCCESS so an offline
      // session retries on the next mount instead of white-waiting an hour
      const [latestVer, setLatestVer] = React.useState(updateCheck.latest);
      const clientCfg = state.phase === 'ok' && state.client && typeof state.client === 'object' ? state.client : null;
      React.useEffect(() => {
        let alive = true;
        const interval = Number(clientCfg?.updateCheckMs) || UPDATE_CHECK_MS;
        if (Date.now() - updateCheck.at < interval) return undefined;
        fetch('https://registry.npmjs.org/' + NPM_PACKAGE + '/latest', { headers: { accept: 'application/json' } })
          .then((res) => (res.ok ? res.json() : null))
          .then((json) => {
            const v = json && typeof json.version === 'string' ? json.version : null;
            if (alive && v) {
              updateCheck.at = Date.now(); // success only: failures retry next mount
              updateCheck.latest = v;
              setLatestVer(v);
            }
          })
          .catch(() => { /* offline / blocked: footer stays version-only */ });
        return () => { alive = false; };
      }, [clientCfg]);
      // numeric x.y.z compare; pre-release tags ('-beta') are truncated by
      // parseInt and therefore compared as their leading numbers — fine for
      // this plugin's plain-number releases, don't ship tagged versions
      const isNewer = (candidate, current) => {
        const a = String(candidate).split('.').map((n) => parseInt(n, 10));
        const b = String(current).split('.').map((n) => parseInt(n, 10));
        for (let i = 0; i < 3; i += 1) {
          if ((a[i] || 0) > (b[i] || 0)) return true;
          if ((a[i] || 0) < (b[i] || 0)) return false;
        }
        return false;
      };
      const selfUpdateEnabled = clientCfg ? clientCfg.enableSelfUpdate !== false : true;
      const hasUpdate = selfUpdateEnabled && latestVer && isNewer(latestVer, PLUGIN_VERSION);
      const [updatePhase, setUpdatePhase] = React.useState('idle');
      const [confirmOpen, setConfirmOpen] = React.useState(false);
      const updWrapRef = React.useRef(null);
      React.useEffect(() => {
        if (!confirmOpen) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') setConfirmOpen(false); };
        const onDown = (event) => {
          if (updWrapRef.current && !updWrapRef.current.contains(event.target)) setConfirmOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDown);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onDown);
        };
      }, [confirmOpen]);
      const startUpdate = () => {
        if (updatePhase === 'running' || updatePhase === 'done') return;
        setUpdatePhase('running');
        fetch('/api/glm-quota/update', { method: 'POST' })
          .then((res) => res.json())
          .then((json) => {
            if (json && json.ok) {
              setUpdatePhase('done');
              setTimeout(() => window.location.reload(), 1500);
            } else {
              setUpdatePhase('failed');
            }
          })
          .catch(() => setUpdatePhase('failed'));
      };

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDown);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onDown);
        };
      }, [open]);

      // Early return AFTER every hook: conditional hook counts crash the slot entry.
      if (!isGlmSession || state.configured === false) return null;

      const typeOf = (limit) => String(limit.type || '').toUpperCase();
      const limits = state.phase === 'ok' && state.quota && Array.isArray(state.quota.limits)
        ? state.quota.limits
          .filter((limit) => Number.isFinite(Number(limit.percentage)))
          // the 5h primary window leads the card grid regardless of the
          // API's response order (reference screenshots put it top-left)
          .sort((a, b) => (Number(b.unit) === 3 && typeOf(b).includes('TOKEN') ? 1 : 0) - (Number(a.unit) === 3 && typeOf(a).includes('TOKEN') ? 1 : 0))
        : [];
      const segments = [
        { key: 'tokens', label: t('seg5h'), limit: limits.find((limit) => typeOf(limit).includes('TOKEN') && Number(limit.unit) === 3) },
        { key: 'week', label: t('segWeek'), limit: limits.find((limit) => Number(limit.unit) === 4) },
        { key: 'tools', label: t('segTool'), limit: limits.find((limit) => { const ty = typeOf(limit); return ty.includes('TIME') || ty.includes('TOOL') || ty.includes('MCP'); }) },
      ].filter((seg) => seg.limit !== undefined);

      let pillContent;
      if (state.phase === 'loading') pillContent = t('loading');
      else if (state.phase === 'error') pillContent = h('span', { title: String(state.error || ''), style: { color: 'var(--dsw-alias-state-error-primary)' } }, 'GLM !');
      else if (segments.length === 0) {
        const suffix = state.stale ? '*' : '';
        pillContent = [
          h('span', { key: 'name' }, 'GLM'),
          h('span', { key: 'pct', className: 'glmq-pct' }, '·' + suffix),
        ];
      } else {
        const suffix = state.stale ? '*' : '';
        // Variant A: the 5h window's reset countdown joins the pill as a muted
        // trailing segment. Segment colors share the panel cards' accent
        // palette (same limit → same color), still overridden at warn/critical.
        const primary = segments[0];
        const primaryPct = Math.max(0, Math.min(100, Math.round(Number(primary.limit.percentage) || 0)));
        const primaryReset = resetInfo(primary.limit.nextResetTime, t);
        pillContent = [
          h('span', { key: 'name' }, 'GLM'),
          ...segments.map((seg, index) => {
            const pct = Math.max(0, Math.min(100, Math.round(Number(seg.limit.percentage) || 0)));
            const accent = cardColor(pct, seg.limit, typeOf(seg.limit));
            return h('span', { key: seg.key, className: 'glmq-seg', title: limitInfo(seg.limit, t).label },
              h('span', { className: 'glmq-seg-label' }, seg.label),
              h('span', { className: 'glmq-pct', style: { '--glmq-state': accent } }, pct + '%'),
              index < segments.length - 1 ? h('span', { className: 'glmq-sep' }, '·') : null);
          }),
          primaryReset
            ? h('span', { key: 'reset', className: 'glmq-seg', title: `${limitInfo(primary.limit, t).label} · ${primaryReset.title}` },
              h('span', { className: 'glmq-sep' }, '·'),
              h('span', { className: 'glmq-reset', style: { '--glmq-state': cardColor(primaryPct, primary.limit, typeOf(primary.limit)) } },
                CLOCK_ICON,
                h('span', { className: 'glmq-hhmm' }, primaryReset.countdown)))
            : null,
          suffix ? h('span', { key: 'suffix', className: 'glmq-pct' }, suffix) : null,
        ];
      }

      return h('div', { className: 'glmq-root', ref: rootRef },
        h('button', {
          className: 'glmq-pill',
          'aria-expanded': open,
          title: selectionNow ? `GLM Coding Plan · model: ${selectionNow.model} (${selectionNow.provider})` : 'GLM Coding Plan',
          onClick: () => setOpen((value) => !value),
        }, h('span', { className: 'glmq-mark' }, MARK_ICON), pillContent),
        open && h('div', { className: 'glmq-panel', role: 'dialog', 'aria-label': 'GLM Coding Plan' },
          h('div', { className: 'glmq-panel-head' },
            MARK_ICON,
            h('span', null, 'GLM Coding Plan'),
            state.phase === 'ok' && state.quota && state.quota.level
              ? (() => {
                const rawLevel = String(state.quota.level).trim();
                const tierMatch = rawLevel.match(/lite|pro|max/i);
                const tier = tierMatch ? tierMatch[0][0].toUpperCase() + tierMatch[0].slice(1).toLowerCase() : rawLevel;
                const desc = planInfo(state.quota, t);
                const tip = (desc ? desc + t('planTipSuffix') : '') + tier;
                return h('span', { className: 'glmq-plan-tag', 'data-tip': tip }, tier);
              })()
              : null,
            h('span', { className: 'glmq-spacer' }),
            h('a', {
              className: 'glmq-extlink',
              href: USAGE_PAGE_URL,
              target: '_blank',
              rel: 'noopener',
              title: t('usagePage'),
              'aria-label': t('usagePage'),
            }, EXTLINK_ICON),
            h('button', { className: 'glmq-refresh', title: t('refresh'), 'aria-label': t('refresh'), onClick: () => refresh(true) }, REFRESH_ICON)),
          limits.length > 0
            ? h('div', { className: 'glmq-cards' }, limits.map((limit) => h(LimitRow, {
              key: limit.type, limit, t,
              // the 5h token window is the primary (countdown) card
              isPrimary: typeOf(limit).includes('TOKEN') && Number(limit.unit) === 3,
            })))
            : h('div', { className: 'glmq-meta' }, state.phase === 'error' ? t('error') : t('loading')),
          (() => {
            const mu = state.modelUsage;
            const total = mu && mu.totalUsage;
            if (!total) return null;
            const rows = (Array.isArray(total.modelSummaryList) ? total.modelSummaryList.slice() : [])
              .sort((x, y) => Number(x.sortOrder ?? 0) - Number(y.sortOrder ?? 0))
              .slice(0, 6);
            // hourly token series -> mini sparkline; tooltip carries the time
            // range, peak hour and the call-count series
            const series = Array.isArray(mu.tokensUsage) ? mu.tokensUsage : [];
            const times = Array.isArray(mu.x_time) ? mu.x_time : [];
            const calls = Array.isArray(mu.modelCallCount) ? mu.modelCallCount : [];
            const peak = series.length > 0 ? Math.max(...series) : 0;
            const callsSum = calls.reduce((sum, n) => sum + (Number(n) || 0), 0);
            const spark = series.length > 0 && peak > 0
              ? h('div', {
                className: 'glmq-spark',
                title: String(t('sparkTip') || '{range} · {peak} · {calls}')
                  .replace('{range}', times.length > 0 ? `${times[0]} – ${times[times.length - 1]}` : '-')
                  .replace('{peak}', fmtCompact(peak, loc))
                  .replace('{calls}', String(callsSum)),
              }, series.map((value, i) => {
                const v = Number(value) || 0;
                return h('span', {
                  key: i,
                  // zero hours collapse to a faint 2px baseline so real usage
                  // bars always read clearly against empty time slots
                  style: { height: v > 0 ? Math.max(4, Math.round((v / peak) * 100)) + '%' : '2px', opacity: v > 0 ? undefined : '.25' },
                });
              }))
              : null;
            // The header row doubles as the collapse toggle: collapsed (the
            // default) keeps only the label + 24h total, while the sparkline,
            // per-model list and call count mount only while expanded.
            return h('div', { className: 'glmq-limit' },
              h('button', {
                className: 'glmq-usage-toggle',
                'aria-expanded': usageOpen,
                onClick: () => setUsageOpen((value) => !value),
              },
                h('span', { className: 'glmq-limit-label' }, t('usage24h')),
                h('span', { className: 'glmq-limit-value' }, fmtCompact(total.totalTokensUsage, loc)),
                h('span', { className: 'glmq-usage-chev' }, CHEVRON_ICON)),
              usageOpen ? spark : null,
              usageOpen && rows.length > 0 ? h('ul', { className: 'glmq-detail' },
                rows.map((model) => h('li', { key: model.modelName },
                  h('span', null, model.modelName),
                  h('span', { className: 'glmq-detail-usage' }, fmtCompact(model.totalTokens, loc))))) : null,
              usageOpen ? h('div', { className: 'glmq-meta' }, `${total.totalModelCallCount ?? 0} ${t('calls')}`) : null);
          })(),
          state.phase === 'ok' && state.fetchedAt
            ? (() => {
              const cached = `${state.stale ? t('stale') + ' · ' : ''}${t('cachedPrefix')} ${new Date(state.fetchedAt).toLocaleTimeString()}`;
              return h('div', { className: 'glmq-panel-foot' },
                h('span', null, cached),
                h('span', { className: 'glmq-spacer' }),
                hasUpdate
                  ? h('span', { key: 'upd', className: 'glmq-upd-wrap', ref: updWrapRef },
                    h('button', {
                      className: 'glmq-upd' + (updatePhase === 'running' ? ' glmq-upd-busy' : '') + (updatePhase === 'failed' ? ' glmq-upd-fail' : ''),
                      title: updatePhase === 'failed'
                        ? String(t('updateFailed'))
                        : `v${PLUGIN_VERSION} → v${latestVer}`,
                      onClick: () => { if (updatePhase === 'idle' || updatePhase === 'failed') setConfirmOpen(true); },
                    }, updatePhase === 'running' ? t('updating')
                      : updatePhase === 'done' ? t('updateDone')
                      : updatePhase === 'failed' ? t('updateFailed')
                      : t('newVersion')),
                    confirmOpen && updatePhase !== 'running' && updatePhase !== 'done'
                      ? h('div', { className: 'glmq-confirm', role: 'dialog', 'aria-label': t('confirmUpdate') },
                        h('div', { className: 'glmq-confirm-text' },
                          String(t('confirmUpdate') || 'Update to {v}?').replace('{v}', 'v' + latestVer)),
                        h('div', { className: 'glmq-confirm-actions' },
                          h('button', { className: 'glmq-btn glmq-btn-ghost', onClick: () => setConfirmOpen(false) }, t('cancel')),
                          h('button', { className: 'glmq-btn glmq-btn-go', onClick: () => { setConfirmOpen(false); startUpdate(); } }, t('confirm'))))
                      : null)
                  : null,
                h('span', { key: 'ver', className: 'glmq-ver', title: `dsh-glm-quota-dock v${PLUGIN_VERSION}` }, 'v' + PLUGIN_VERSION));
            })()
            : null));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale');
        let t = (key) => (DICTS.zh[key] ?? DICTS.en[key] ?? key);
        let loc = 'en';
        if (locale && typeof locale.register === 'function') {
          locale.register(NS, { zh: DICTS.zh, en: DICTS.en });
          if (typeof locale.bind === 'function') t = locale.bind(NS);
          try {
            const snapshot = typeof locale.getLocale === 'function' ? locale.getLocale() : null;
            if (snapshot && snapshot.active) loc = String(snapshot.active).startsWith('zh') ? 'zh' : 'en';
          } catch {
            /* keep 'en' */
          }
        }

        const style = document.createElement('style');
        style.textContent = CSS;
        style.setAttribute('data-plugin', 'dsh-glm-quota-dock');
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'glm-quota-dock: styles');

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'glm-quota',
          order: 1,
        }, (props) => h(QuotaWidget, { ...props, t, loc })));
      },
    };
  },
});
