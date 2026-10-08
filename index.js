// GLM 额度 dock 插件的 Host 半部(进程内 Harness 插件)。
//
// 注册 GET /api/glm-quota(位于 /api 信任栅栏与浏览器鉴权之后),返回缓存的
// GLM Coding Plan 额度数据。API Key 不会离开 Host 进程:它从凭据服务解析
// (config.apiKeyRef,默认 ZAI_CODING_CN_API_KEY),或取 config.apiKey——
// 与 dsh-llm-pi-ai 为 zai-coding-cn 路由读取同一凭据引用的方式一致。
//
// 上游端点(官方 glm-plan-usage / ZCode 监控接口):
//   GET {endpoint}/api/monitor/usage/quota/limit
//   GET {endpoint}/api/monitor/usage/model-usage?startTime=...&endTime=...
//   Authorization: <裸 key,无 Bearer 前缀>
//   -> { code: 200, success: true, data: ... }

const DEFAULT_REF = "ZAI_CODING_CN_API_KEY";
const DEFAULT_ENDPOINT = "https://open.bigmodel.cn";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const MODEL_USAGE_PATH = "/api/monitor/usage/model-usage";
const MIN_INTERVAL_MS = 30_000;
const DEFAULT_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** 声明依赖顺序:排在这些服务之后激活,保证 ctx.get 一定能取到。 */
export const inject = ["connection", "credentials"];

/** @type {{ payload: object, fetchedAt: number } | null} */
let cached = null;
let inflight = null;

function fail(message) {
  return new Error(`glm-quota-dock: ${message}`);
}

// 解析上游鉴权 key:优先 config.apiKey,否则从凭据服务按引用名解析。
async function resolveKey(ctx, config) {
  const literal = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  if (literal.length > 0) return literal;
  const credentials = ctx.get("credentials");
  if (!credentials || typeof credentials.resolve !== "function") {
    throw fail("credentials service is unavailable");
  }
  const ref = typeof config?.apiKeyRef === "string" && config.apiKeyRef.trim().length > 0
    ? config.apiKeyRef.trim()
    : DEFAULT_REF;
  const resolved = await credentials.resolve(ref);
  const value = typeof resolved?.value === "string" ? resolved.value.trim() : "";
  if (value.length === 0) {
    throw fail(`credential "${ref}" is not configured (set it on the web Models page or via config.apiKey)`);
  }
  return value;
}

function endpointBase(config) {
  const raw = typeof config?.endpoint === "string" ? config.endpoint.trim() : "";
  return (raw.length > 0 ? raw : DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

/** 与官方 glm-plan-usage 相同的时间窗:昨天同一小时 -> 今天当前小时结束。 */
function usageWindow() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours(), 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 59, 59, 999);
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `startTime=${encodeURIComponent(fmt(start))}&endTime=${encodeURIComponent(fmt(end))}`;
}

async function getJson(url, key) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: key,
        "Accept-Language": "en-US,en",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw fail(`upstream request failed: ${error && error.cause ? String(error.cause) : String(error)}`);
  }
  if (!res.ok) throw fail(`upstream HTTP ${res.status}`);
  const json = await res.json().catch(() => null);
  if (json && json.code === 200 && json.success !== false) return json;
  throw fail(`upstream error ${json?.code ?? "?"}: ${json?.msg ?? "unknown"}`);
}

// 拉取并缓存:先解析 key(失败 = 未配置,configured:false);额度主请求失败
// 则整体失败;model-usage 为辅,失败不阻塞。已有缓存时降级为 stale 数据。
async function refresh(ctx, config) {
  let key;
  try {
    key = await resolveKey(ctx, config);
  } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : String(error);
    return { ok: false, configured: false, error: message, fetchedAt: Date.now() };
  }
  try {
    const base = endpointBase(config);
    const [quotaResult, usageResult] = await Promise.allSettled([
      getJson(base + QUOTA_PATH, key),
      getJson(`${base + MODEL_USAGE_PATH}?${usageWindow()}`, key),
    ]);
    if (quotaResult.status !== "fulfilled") throw quotaResult.reason;
    const payload = {
      ok: true,
      configured: true,
      quota: quotaResult.value.data ?? null,
      modelUsage: usageResult.status === "fulfilled" ? usageResult.value.data ?? null : null,
      fetchedAt: Date.now(),
    };
    cached = { payload, fetchedAt: payload.fetchedAt };
    return { ...payload, cached: false };
  } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : String(error);
    if (cached) {
      return { ...cached.payload, stale: true, lastError: message };
    }
    return { ok: false, configured: true, error: message, fetchedAt: Date.now() };
  }
}

// 带最小间隔的缓存读取:缓存足够新时直接返回;force 绕过缓存;
// 并发请求共享同一个进行中的 refresh(inflight 去重)。
async function getQuota(ctx, config, force) {
  const configured = Number(config?.minIntervalSec);
  const minMs = Number.isFinite(configured) && configured > 0
    ? Math.max(MIN_INTERVAL_MS, configured * 1000)
    : DEFAULT_INTERVAL_MS;
  const fresh = cached !== null && Date.now() - cached.fetchedAt < minMs;
  if (fresh && !force) return { ...cached.payload, cached: true };
  if (!inflight) {
    inflight = refresh(ctx, config).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Host 插件:注册经过鉴权的 /api/glm-quota 精确 Fetch 路由。 */
export function apply(ctx, config) {
  const connection = ctx.get("connection");
  if (!connection?.fetch || typeof connection.fetch.register !== "function") {
    throw fail("connection service is unavailable; cannot serve /api/glm-quota");
  }
  const dispose = connection.fetch.register({
    path: "/api/glm-quota",
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const force = String(request?.url ?? "").includes("force=1");
      const payload = await getQuota(ctx, config, force);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    },
  });
  return dispose;
}
