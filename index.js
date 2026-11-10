// GLM 额度 dock 插件的 Host 半部(进程内 Harness 插件)。
//
// 注册三个经 /api 信任栅栏与浏览器鉴权后的路由:
//   GET  /api/glm-quota          缓存的额度数据(client 轮询)
//   GET  /api/glm-quota/version  最新发布版本(走 pnpm/npm 同源的 registry 配置)
//   POST /api/glm-quota/update   在本 profile 内执行 pnpm 自更新
//
// API Key 不会离开 Host 进程:它从凭据服务解析(config.apiKeyRef,默认
// ZAI_CODING_CN_API_KEY),或取 config.apiKey——与 dsh-llm-pi-ai 为
// zai-coding-cn 路由读取同一凭据引用的方式一致。
//
// 上游端点(官方 glm-plan-usage / ZCode 监控接口):
//   GET {endpoint}/api/monitor/usage/quota/limit
//   GET {endpoint}/api/monitor/usage/model-usage?startTime=...&endTime=...
//   Authorization: <裸 key,无 Bearer 前缀>
//   -> { code: 200, success: true, data: ... }
//
// 团队版 Coding Plan(组织/项目维度):监控接口默认查个人套餐,团队版必须
// 追加 ?type=2 并附带 Bigmodel-Organization / Bigmodel-Project 两个请求头,
// 否则返回 {"code":500,"msg":"当前用户不存在coding plan"}。配置
// organizationId + projectId 即启用团队模式(见 README「团队版 Coding Plan」)。

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
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const MODEL_USAGE_PATH = "/api/monitor/usage/model-usage";
const MIN_INTERVAL_MS = 30_000;
const DEFAULT_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
// 手动强制刷新的最短间隔:连点刷新不再逐个打上游
const FORCE_MIN_INTERVAL_MS = 5_000;
// 版本查询缓存:一小时一次的客户端检查不必每次都起 pnpm
const VERSION_CACHE_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 20_000;
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
      for (const key of ["endpoint", "apiKey", "apiKeyRef", "registry", "organizationId", "projectId"]) {
        if (input[key] === undefined || input[key] === null) continue;
        if (typeof input[key] !== "string" || input[key].trim() === "") {
          issues.push({ message: `${key} must be a non-empty string`, path: [key] });
        } else {
          out[key] = input[key];
        }
      }
      for (const key of ["endpoint", "registry"]) {
        if (typeof out[key] === "string" && !/^https?:\/\//i.test(out[key].trim())) {
          issues.push({ message: `${key} must be an http(s) URL`, path: [key] });
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
/** 上一次强制刷新打上游的时刻(节流用) */
let lastForceAt = 0;
/** 版本查询结果缓存:{ at, value } */
let versionCache = null;
/** 本进程实际加载的包版本(用于判断自更新是否已越过运行中的 Host 半部) */
let runningVersionCache;

function fail(message) {
  return new Error(`glm-quota-dock: ${message}`);
}

function errorMessage(error) {
  if (error && typeof error.message === "string") return error.message;
  return String(error);
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

async function getJson(url, key, extraHeaders) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: key,
        "Accept-Language": "en-US,en",
        accept: "application/json",
        ...(extraHeaders ?? {}),
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

/** 本进程加载的包版本;读不到时返回 null(不阻塞任何功能)。 */
function runningVersion() {
  if (runningVersionCache !== undefined) return runningVersionCache;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(fsSync.readFileSync(path.join(here, "package.json"), "utf8"));
    runningVersionCache = typeof manifest?.version === "string" ? manifest.version.trim() : null;
  } catch {
    runningVersionCache = null;
  }
  return runningVersionCache;
}

/** 客户端轮询参数与能力开关;成功/降级/未配置三条路径都下发,避免错误态丢配置。 */
function clientInfo(config) {
  return {
    version: runningVersion(),
    pollMs: minPollMs(config),
    idleAfterMs: CLIENT_IDLE_AFTER_MS,
    idlePollMs: CLIENT_IDLE_POLL_MS,
    updateCheckMs: CLIENT_UPDATE_CHECK_MS,
    enableSelfUpdate: config?.enableSelfUpdate !== false,
  };
}

/**
 * 团队版 Coding Plan 上下文:organizationId + projectId 同时配置即启用。
 * 团队版监控接口必须带 ?type=2 与 Bigmodel-Organization / Bigmodel-Project
 * 两个请求头(只给 key 时返回 data:{} 空对象;不传 type 则按个人套餐解析,
 * 团队版 key 会报「当前用户不存在coding plan」)。
 */
function teamContext(config) {
  const organizationId = typeof config?.organizationId === "string" ? config.organizationId.trim() : "";
  const projectId = typeof config?.projectId === "string" ? config.projectId.trim() : "";
  if (organizationId.length === 0 || projectId.length === 0) return null;
  return {
    organizationId,
    projectId,
    headers: {
      "Bigmodel-Organization": organizationId,
      "Bigmodel-Project": projectId,
    },
  };
}

// 拉取并缓存:先解析 key(失败 = 未配置,configured:false);额度主请求失败
// 则整体失败;model-usage 为辅,失败不阻塞。已有缓存时降级为 stale 数据。
async function refresh(ctx, config) {
  let key;
  try {
    key = await resolveKey(ctx, config);
  } catch (error) {
    return {
      ok: false,
      configured: false,
      error: errorMessage(error),
      fetchedAt: Date.now(),
      client: clientInfo(config),
    };
  }
  try {
    const base = endpointBase(config);
    const team = teamContext(config);
    const quotaUrl = team ? `${base}${QUOTA_PATH}?type=2` : base + QUOTA_PATH;
    const usageUrl = team
      ? `${base}${MODEL_USAGE_PATH}?${usageWindow()}&type=2`
      : `${base}${MODEL_USAGE_PATH}?${usageWindow()}`;
    const [quotaResult, usageResult] = await Promise.allSettled([
      getJson(quotaUrl, key, team?.headers),
      getJson(usageUrl, key, team?.headers),
    ]);
    if (quotaResult.status !== "fulfilled") throw quotaResult.reason;
    const payload = {
      ok: true,
      configured: true,
      planType: team ? "team" : "personal",
      quota: quotaResult.value.data ?? null,
      modelUsage: usageResult.status === "fulfilled" ? usageResult.value.data ?? null : null,
      modelUsageError: usageResult.status === "rejected" ? errorMessage(usageResult.reason) : null,
      fetchedAt: Date.now(),
      // 下发客户端轮询参数与能力开关,client 不再各自硬编码
      client: clientInfo(config),
    };
    cached = { payload, fetchedAt: payload.fetchedAt };
    return { ...payload, cached: false };
  } catch (error) {
    const message = errorMessage(error);
    if (cached) {
      return { ...cached.payload, stale: true, lastError: message };
    }
    return {
      ok: false,
      configured: true,
      error: message,
      fetchedAt: Date.now(),
      client: clientInfo(config),
    };
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
  const now = Date.now();
  const fresh = cached !== null && now - cached.fetchedAt < minMs;
  if (force) {
    // 在途请求本身就是一次真实上游拉取:强制刷新搭车即可,不另起一次
    if (inflight) return inflight;
    // 连点刷新:节流窗口内直接给缓存;没有缓存时才放行一次真实请求
    if (cached && now - lastForceAt < FORCE_MIN_INTERVAL_MS) {
      return { ...cached.payload, cached: true, throttled: true };
    }
    lastForceAt = now;
  } else if (fresh) {
    return { ...cached.payload, cached: true };
  }
  if (!inflight) {
    inflight = refresh(ctx, config).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** 只接受 ?force=1(而非子串匹配,`?force=10` 不再误命中)。 */
function wantsForce(request) {
  try {
    const url = new URL(String(request?.url ?? "/api/glm-quota"), "http://localhost");
    return url.searchParams.get("force") === "1";
  } catch {
    return false;
  }
}

/** 从 npmrc 文本里取最后一次 registry 配置。 */
function registryFromNpmrc(file) {
  try {
    let found = "";
    for (const line of fsSync.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*registry\s*=\s*(\S+)\s*$/i);
      if (match) found = match[1];
    }
    return found.trim();
  } catch {
    return "";
  }
}

/** 版本查询用的 registry:config.registry → 环境变量 → profile/.npmrc → ~/.npmrc → 官方 registry。
 *  与 pnpm 安装同源,避免"镜像滞后 → 显示可更新 → 更新 → 版本没变 → 又显示可更新"的回环。 */
function registryBase(config) {
  const explicit = typeof config?.registry === "string" ? config.registry.trim() : "";
  if (explicit) return explicit.replace(/\/+$/, "");
  const fromEnv = String(process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || "").trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const files = [path.join(os.homedir(), ".npmrc")];
  try {
    files.push(path.join(profileDir(), ".npmrc"));
  } catch { /* no profile dir: user-level only */ }
  let found = "";
  for (const file of files) {
    const value = registryFromNpmrc(file);
    if (value) found = value; // profile 级覆盖用户级
  }
  return (found || DEFAULT_REGISTRY).replace(/\/+$/, "");
}

function parseVersionOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
    if (parsed && typeof parsed.version === "string") return parsed.version;
  } catch { /* not JSON: fall through to a lenient match */ }
  const match = text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

/** 用 pnpm 查最新版:与安装共用 registry/代理/鉴权配置。 */
async function latestViaPnpm() {
  let cwd;
  try {
    cwd = profileDir();
  } catch {
    cwd = os.homedir();
  }
  for (const candidate of pnpmCandidates()) {
    const [cmd, ...rest] = candidate;
    const args = rest.filter((a) => typeof a === "string");
    const opts = { cwd, timeout: VERSION_TIMEOUT_MS, windowsHide: true, ...rest.find((a) => a && typeof a === "object") };
    try {
      const { stdout } = await run(cmd, [...args, "view", NPM_PACKAGE, "version", "--json"], opts);
      const version = parseVersionOutput(stdout);
      if (version) return version;
    } catch { /* try next candidate */ }
  }
  return null;
}

/** 回退路径:直接问 registry(HTTP 代理环境可能不可达,故只作兜底)。 */
async function latestViaRegistry(base) {
  const res = await fetch(`${base}/${NPM_PACKAGE}/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw fail(`registry HTTP ${res.status}`);
  const json = await res.json().catch(() => null);
  const version = json && typeof json.version === "string" ? json.version.trim() : "";
  if (!version) throw fail("registry response has no version field");
  return version;
}

async function latestVersion(config) {
  if (versionCache && Date.now() - versionCache.at < VERSION_CACHE_MS) {
    return { ...versionCache.value, cached: true };
  }
  let version = null;
  let source = "none";
  let failure = null;
  const viaPnpm = await latestViaPnpm();
  if (viaPnpm) {
    version = viaPnpm;
    source = "pnpm";
  } else {
    const base = registryBase(config);
    try {
      version = await latestViaRegistry(base);
      source = base;
    } catch (error) {
      failure = errorMessage(error);
    }
  }
  if (!version) {
    // 失败不缓存:网络恢复后下一次询问立刻重试
    return { ok: false, error: failure || "version lookup failed" };
  }
  const value = { ok: true, version, source };
  versionCache = { at: Date.now(), value };
  return value;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
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

let updateInflight = null;

async function runSelfUpdate() {
  let dir;
  try {
    dir = profileDir();
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) }, 500);
  }
  const before = runningVersion();
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
      versionCache = null; // 装完后让下一次版本查询重新确认
      return json({
        ok: true,
        version,
        runningVersion: before,
        // null = 无法判定(读不到自身版本);客户端此时保持原行为
        restartRequired: before ? version !== before : null,
      });
    } catch (error) {
      lastError = String(error?.message || error);
    }
  }
  return json({ ok: false, error: lastError }, 500);
}

/** Host 插件:注册经过鉴权的 /api/glm-quota* 精确 Fetch 路由。 */
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
      const payload = await getQuota(ctx, config, wantsForce(request));
      return json(payload);
    },
  });

  const disposeVersion = connection.fetch.register({
    path: "/api/glm-quota/version",
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async () => json(await latestVersion(config)),
  });

  // 自更新:POST /api/glm-quota/update 在 profile 目录执行 pnpm 升级本包,
  // 返回安装到的新版本与运行中版本。前端资源刷新页面即可生效;Host 半部的
  // 变更仍需重启 DSH(由 restartRequired 告知客户端)。pnpm 解析顺序:
  // 环境变量 → DSH 桌面运行时内置 → PATH。
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
  return [dispose, disposeVersion, disposeUpdate];
}
