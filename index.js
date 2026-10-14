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

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";

const run = promisify(execFileCb);

const DEFAULT_REF = "ZAI_CODING_CN_API_KEY";
const DEFAULT_ENDPOINT = "https://open.bigmodel.cn";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const MODEL_USAGE_PATH = "/api/monitor/usage/model-usage";
const MIN_INTERVAL_MS = 30_000;
const DEFAULT_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const NPM_PACKAGE = "dsh-glm-quota-dock";
const UPDATE_TIMEOUT_MS = 180_000;

// 客户端轮询参数(随 payload 下发,避免 client 侧再硬编码一套周期)。
const CLIENT_IDLE_AFTER_MS = 5 * 60_000;
const CLIENT_IDLE_POLL_MS = 5 * 60_000;
const CLIENT_UPDATE_CHECK_MS = 60 * 60_000;

/**
 * Standard Schema v1 最小实现(官方要求导出 Config schema 校验配置;本包零依赖,
 * 不引入 Schemastery,直接实现 Cordis 要求的 '~standard' 接口):加载时校验类型、
 * 填充默认值,非法配置让插件加载失败并给出明确错误。
 */
export const Config = {
  vendor: "glm-quota-dock",
  version: 1,
  "~standard": {
    validate(value) {
      const input = value && typeof value === "object" ? value : {};
      const out = {};
      const issues = [];
      for (const key of ["endpoint", "apiKey", "apiKeyRef"]) {
        if (input[key] === undefined || input[key] === null) continue;
        if (typeof input[key] !== "string" || input[key].trim() === "") {
          issues.push({ message: `${key} must be a non-empty string`, path: [key] });
        } else {
          out[key] = input[key];
        }
      }
      if (input.minIntervalSec !== undefined && input.minIntervalSec !== null) {
        const n = Number(input.minIntervalSec);
        if (!Number.isFinite(n) || n <= 0) issues.push({ message: "minIntervalSec must be a positive number", path: ["minIntervalSec"] });
        else out.minIntervalSec = n;
      }
      if (input.enableSelfUpdate !== undefined && input.enableSelfUpdate !== null) {
        if (typeof input.enableSelfUpdate !== "boolean") issues.push({ message: "enableSelfUpdate must be a boolean", path: ["enableSelfUpdate"] });
        else out.enableSelfUpdate = input.enableSelfUpdate;
      }
      if (issues.length > 0) return { issues };
      return { value: out };
    },
  },
};

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
      // 下发客户端轮询参数与能力开关,client 不再各自硬编码
      client: {
        pollMs: minPollMs(config),
        idleAfterMs: CLIENT_IDLE_AFTER_MS,
        idlePollMs: CLIENT_IDLE_POLL_MS,
        updateCheckMs: CLIENT_UPDATE_CHECK_MS,
        enableSelfUpdate: config?.enableSelfUpdate !== false,
      },
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
function minPollMs(config) {
  const configured = Number(config?.minIntervalSec);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(MIN_INTERVAL_MS, configured * 1000)
    : DEFAULT_INTERVAL_MS;
}

async function getQuota(ctx, config, force) {
  const minMs = minPollMs(config);
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

  // 自更新:POST /api/glm-quota/update 在 profile 目录执行 pnpm 升级本包,
  // 返回安装到的新版本。仅前端资源刷新页面即可生效;Host 半部的变更仍需
  // 重启 DSH。pnpm 解析顺序:环境变量 → DSH 桌面运行时内置 → PATH。
  const disposeUpdate = connection.fetch.register({
    path: "/api/glm-quota/update",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async () => {
      if (config?.enableSelfUpdate === false) {
        return json({ ok: false, error: "self-update disabled by config (enableSelfUpdate: false)" }, 403);
      }
      if (updateInflight) return json({ ok: false, error: "update already in progress" }, 409);
      updateInflight = runSelfUpdate().finally(() => { updateInflight = null; });
      return updateInflight;
    },
  });
  return [dispose, disposeUpdate];
}

let updateInflight = null;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 本包安装位置倒推 profile 目录(node_modules/dsh-glm-quota-dock/ → profile)。
 *  仅在 hoisted 布局下成立;防御性校验目标目录确实是 profile(含 dsh.profile)。 */
function profileDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, "..", "..");
  const manifest = path.join(dir, "package.json");
  if (fsSync.existsSync(manifest)) {
    try {
      if (JSON.parse(fsSync.readFileSync(manifest, "utf8"))?.dsh?.profile) return dir;
    } catch { /* fall through */ }
  }
  throw new Error("cannot locate profile directory (non-hoisted install layout?)");
}

function pnpmCandidates() {
  const list = [];
  if (process.env.PNPM_PATH) list.push([process.execPath, process.env.PNPM_PATH]);
  list.push([
    process.execPath,
    path.join(os.homedir(), ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs"),
  ]);
  // PATH 回退:Windows 下 pnpm 是 .cmd,execFile 不经 shell 跑不了,用 shell 转发
  list.push(["pnpm", { shell: true }]);
  return list;
}

async function runSelfUpdate() {
  let dir;
  try {
    dir = profileDir();
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) }, 500);
  }
  const args = ["update", NPM_PACKAGE, "--latest", "--config.minimum-release-age=0"];
  let lastError = "no pnpm candidate worked";
  for (const candidate of pnpmCandidates()) {
    const [cmd, ...rest] = candidate;
    const cmdArgs = rest.filter((a) => typeof a === "string");
    const opts = { cwd: dir, timeout: UPDATE_TIMEOUT_MS, windowsHide: true, ...rest.find((a) => a && typeof a === "object") };
    try {
      await run(cmd, [...cmdArgs, ...args], opts);
      const pkgFile = path.join(dir, "node_modules", NPM_PACKAGE, "package.json");
      const version = JSON.parse(await fs.readFile(pkgFile, "utf8")).version;
      return json({ ok: true, version });
    } catch (error) {
      lastError = String(error?.message || error);
    }
  }
  return json({ ok: false, error: lastError }, 500);
}
