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

    const DICTS = {
      zh: {
        planLabel: '额度',
        tokensBase: 'Token 额度',
        toolsBase: '工具调用额度',
        creditsBase: '积分额度',
        unitHour: '小时',
        unitWeek: '周',
        unitMonth: '个月',
        unitDay: '天',
        resetIn: '重置',
        refresh: '刷新',
        loading: '读取中…',
        error: '额度获取失败',
        stale: '数据过期',
        cachedPrefix: '缓存于',
        usageDetail: '用量明细',
        usage24h: '近 24 小时 Token',
        calls: '次调用',
        seg5h: '5h',
        segWeek: '周',
        segTool: '工具',
        planDescV1: '历史版本 V1:5 小时滚动 Token 窗口 + 月度工具调用额度',
        planDescV2: '历史版本 V2:Token 窗口制,含每周窗口',
        planDescCredit: '新版积分套餐:按 Token 消耗积分抵扣',
      },
      en: {
        planLabel: 'Quota',
        tokensBase: 'Token quota',
        toolsBase: 'Tool quota',
        creditsBase: 'Credit quota',
        unitHour: 'h',
        unitWeek: 'wk',
        unitMonth: 'mo',
        unitDay: 'd',
        resetIn: 'resets',
        refresh: 'Refresh',
        loading: 'Loading…',
        error: 'Quota unavailable',
        stale: 'stale',
        cachedPrefix: 'cached',
        usageDetail: 'Usage detail',
        usage24h: 'Tokens (last 24h)',
        calls: 'calls',
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
      ".glmq-panel{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);z-index:30;width:264px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);padding:12px;display:flex;flex-direction:column;gap:10px;text-align:left}",
      ".glmq-panel-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600}",
      ".glmq-panel-head svg{flex:none;width:13px;height:13px;color:var(--dsw-alias-brand-primary)}",
      ".glmq-refresh{margin-left:auto;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:2px;border-radius:6px;display:inline-flex}",
      ".glmq-refresh:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".glmq-refresh svg{width:13px;height:13px}",
      ".glmq-limit{display:flex;flex-direction:column;gap:4px}",
      ".glmq-limit-row{display:flex;align-items:baseline;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".glmq-limit-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".glmq-limit-value{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:600}",
      ".glmq-bar{height:4px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}",
      ".glmq-bar-fill{height:100%;border-radius:999px;background:var(--glmq-state,var(--dsw-alias-state-success-primary));transition:width .2s ease}",
      ".glmq-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      ".glmq-info{cursor:help;margin-left:4px;color:var(--dsw-alias-label-tertiary)}",
      ".glmq-info:hover{color:var(--dsw-alias-label-secondary)}",
      ".glmq-seg{display:inline-flex;align-items:center;gap:3px}",
      ".glmq-seg-label{color:var(--dsw-alias-label-tertiary)}",
      ".glmq-sep{margin:0 4px;color:var(--dsw-alias-separator-primary,var(--dsw-alias-label-tertiary))}",
      ".glmq-detail{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".glmq-detail li{display:flex;gap:6px}",
      ".glmq-detail .glmq-detail-usage{margin-left:auto;font-variant-numeric:tabular-nums}",
      "@media (prefers-reduced-motion:reduce){.glmq-bar-fill{transition:none}}",
    ].join("");

    const MARK_ICON = h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('circle', { cx: 8, cy: 8, r: 6.2, stroke: 'currentColor', strokeWidth: 1.6, strokeDasharray: '26 13', strokeLinecap: 'round', transform: 'rotate(-90 8 8)' }),
      h('circle', { cx: 8, cy: 8, r: 2.6, fill: 'currentColor' }));

    const REFRESH_ICON = h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M13.3 6.7A5.4 5.4 0 1 0 13.9 9.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('path', { d: 'M13.5 2.5v4h-4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));

    function stateColor(pct) {
      if (pct >= 95) return 'var(--dsw-alias-state-error-primary)';
      if (pct >= 80) return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-state-success-primary)';
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
      const label = sameDay ? time : `${date.getMonth() + 1}-${date.getDate()} ${time}`;
      const deltaMin = Math.round((ms - Date.now()) / 60_000);
      let countdown;
      if (deltaMin <= 0) countdown = '<1m';
      else if (deltaMin < 60) countdown = `${deltaMin}m`;
      else {
        const hours = Math.floor(deltaMin / 60);
        countdown = hours < 24 ? `${hours}h ${deltaMin % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
      }
      return { label, title: `${t('resetIn')} · ${countdown}` };
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
      return { label: win ? `${base} · ${win}` : base };
    }

    function useQuotaPoll(enabled) {
      const [state, setState] = React.useState({ phase: 'loading' });
      const [, setBump] = React.useState(0);
      const tickRef = React.useRef(null);
      const enabledRef = React.useRef(enabled);
      enabledRef.current = enabled;
      React.useEffect(() => {
        let alive = true;
        let lastFetchAt = 0;
        let lastActivityAt = Date.now();
        const tick = async (force) => {
          if (!enabledRef.current) return;
          lastFetchAt = Date.now();
          try {
            const res = await fetch('/api/glm-quota' + (force ? '?force=1' : ''), { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const json = await res.json();
            if (alive) setState(json.ok ? { phase: 'ok', ...json } : { phase: 'error', error: json.error || 'upstream error' });
          } catch (error) {
            if (alive) setState({ phase: 'error', error: String(error) });
          }
        };
        tickRef.current = tick;
        if (enabledRef.current) tick(false);
        const isActive = () => Date.now() - lastActivityAt < IDLE_AFTER_MS;
        const timer = setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          setBump((n) => n + 1); // force a render so the projection snapshot is re-read even if a notification was missed
          if (enabledRef.current) {
            if (isActive()) {
              tick(false);
            } else if (Date.now() - lastFetchAt >= IDLE_POLL_MS) {
              tick(false); // idle: slow to one fetch per 5 min
            }
          }
        }, POLL_MS);
        const markActivity = () => {
          const wasIdle = !isActive();
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

    function LimitRow({ limit, t }) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(limit.percentage) || 0)));
      const info = limitInfo(limit, t);
      const reset = resetInfo(limit.nextResetTime, t);
      const children = [
        h('div', { className: 'glmq-limit-row', key: 'row' },
          h('span', { className: 'glmq-limit-label' }, info.label),
          reset ? h('span', { className: 'glmq-meta', title: reset.title }, `${t('resetIn')} ${reset.label}`) : null,
          h('span', { className: 'glmq-limit-value', style: { color: stateColor(pct) } }, pct + '%')),
        h('div', { className: 'glmq-bar', key: 'bar' },
          h('div', { className: 'glmq-bar-fill', style: { width: pct + '%', '--glmq-state': stateColor(pct) } })),
      ];
      if (Array.isArray(limit.usageDetails) && limit.usageDetails.length > 0) {
        children.push(h('ul', { className: 'glmq-detail', key: 'detail' },
          limit.usageDetails.map((entry, index) => h('li', { key: entry.modelCode || String(index) },
            h('span', null, entry.modelCode || entry.show_name || '-'),
            h('span', { className: 'glmq-detail-usage' }, String(entry.usage ?? 0))))));
      }
      return h('div', { className: 'glmq-limit' }, children);
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
      const rootRef = React.useRef(null);

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

      const limits = state.phase === 'ok' && state.quota && Array.isArray(state.quota.limits)
        ? state.quota.limits.filter((limit) => Number.isFinite(Number(limit.percentage)))
        : [];
      const typeOf = (limit) => String(limit.type || '').toUpperCase();
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
        pillContent = [
          h('span', { key: 'name' }, 'GLM'),
          ...segments.map((seg, index) => {
            const pct = Math.max(0, Math.min(100, Math.round(Number(seg.limit.percentage) || 0)));
            return h('span', { key: seg.key, className: 'glmq-seg', title: limitInfo(seg.limit, t).label },
              h('span', { className: 'glmq-seg-label' }, seg.label),
              h('span', { className: 'glmq-pct', style: { '--glmq-state': stateColor(pct) } }, pct + '%'),
              index < segments.length - 1 ? h('span', { className: 'glmq-sep' }, '·') : null);
          }),
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
            h('button', { className: 'glmq-refresh', title: t('refresh'), 'aria-label': t('refresh'), onClick: () => refresh(true) }, REFRESH_ICON)),
          limits.length > 0
            ? limits.map((limit) => h(LimitRow, { key: limit.type, limit, t }))
            : h('div', { className: 'glmq-meta' }, state.phase === 'error' ? t('error') : t('loading')),
          (() => {
            const total = state.modelUsage && state.modelUsage.totalUsage;
            if (!total) return null;
            const rows = Array.isArray(total.modelSummaryList) ? total.modelSummaryList.slice(0, 6) : [];
            return h('div', { className: 'glmq-limit' },
              h('div', { className: 'glmq-limit-row' },
                h('span', { className: 'glmq-limit-label' }, t('usage24h')),
                h('span', { className: 'glmq-limit-value' }, fmtCompact(total.totalTokensUsage, loc))),
              rows.length > 0 ? h('ul', { className: 'glmq-detail' },
                rows.map((model) => h('li', { key: model.modelName },
                  h('span', null, model.modelName),
                  h('span', { className: 'glmq-detail-usage' }, fmtCompact(model.totalTokens, loc))))) : null,
              h('div', { className: 'glmq-meta' }, `${total.totalModelCallCount ?? 0} ${t('calls')}`));
          })(),
          state.phase === 'ok' && state.quota && state.quota.level
            ? (() => {
              const desc = planInfo(state.quota, t);
              return h('div', { className: 'glmq-meta' },
                'plan: ' + state.quota.level,
                desc ? h('span', { className: 'glmq-info', title: desc }, 'ⓘ') : null);
            })()
            : null,
          state.phase === 'ok' && state.fetchedAt
            ? h('div', { className: 'glmq-meta' }, `${state.stale ? t('stale') + ' · ' : ''}${t('cachedPrefix')} ${new Date(state.fetchedAt).toLocaleTimeString()}`)
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
