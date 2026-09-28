import { Readable } from "stream";
import logger from "../config/logger.js";
import AppError from "../utils/AppError.js";

const PLUGIN_BASE = process.env.ANGLE_ONE_PLUGIN_BASE_URL || process.env.PLUGIN_BASE_URL || "https://plugin.mintzy.in";
const PLUGIN_API_KEY = process.env.PLUGIN_API_KEY || "changeme-plugin-api-key";

const API_KEY_VM_MAP = {
    "91IIRlrP": "http://34.206.145.136:8000",
    "91IIRIrP": "http://34.206.145.136:8000",
    "2pKOv1sa": "http://44.208.177.169",
    "eyJhbGciOiJodHRwOi8vd3d3LnczLm9yZy8yMDAxLzA0L3htbGRzaWctbW9yZSNobWFjLXNoYTI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOiIxNzgyMzgzNjE5IiwiaXNzIjoibUFyS2V0SHVCIiwiZXhwIjoiMTgxMzc5NTIwMCIsImF1ZCI6IkhPOTk5OSIsImp0aSI6IjIwNyIsImZsZyI6IjY0In0.ueDks3vA9Jn8D1zBQwnnOlLoC9jQtsMIcXjPeNGwM0Q": "http://32.198.166.49:8000"
};

const AUTO_AUTH_API_KEY_PREFIX = "eyJhbGciOiJodHRwOi8vd3d3LnczLm9yZy8yMDAxLzA0L3htbGRzaWctbW9yZSNobWFjLXNoYTI1NiIsInR5cCI6IkpXVCJ9";

const normalizeApiKey = (apiKey) => String(apiKey || "").replace(/\s+/g, "");

const shouldAutoAuthenticateApiKey = (apiKey) => {
    const normalizedApiKey = normalizeApiKey(apiKey);
    return normalizedApiKey === AUTO_AUTH_API_KEY_PREFIX || normalizedApiKey.startsWith(`${AUTO_AUTH_API_KEY_PREFIX}.`);
};

const isForbiddenFallbackUrl = (url) => {
    const value = String(url || "").toLowerCase();
    return (
        !value
        || value.includes("plugin.mintzy.in")
        || value.includes("18.205.165.28")
    );
};

const getMappedVmUrlByApiKey = (apiKey) => {
    if (!apiKey || process.env.PLUGIN_FORCE_LOCAL === "true") {
        return null;
    }

    if (process.env.PLUGIN_USE_VM_ROUTING === "false") {
        return null;
    }

    const mapped = API_KEY_VM_MAP[normalizeApiKey(apiKey)];
    if (!mapped || isForbiddenFallbackUrl(mapped)) {
        return null;
    }

    return mapped.replace(/\/$/, "");
};

const getTargetBaseUrlByApiKey = (apiKey) => {
    if (process.env.PLUGIN_FORCE_LOCAL === "true") {
        return PLUGIN_BASE;
    }

    const mapped = getMappedVmUrlByApiKey(apiKey);
    if (mapped) {
        return mapped;
    }

    throw new AppError("No plugin VM is mapped for this api_key", 400);
};

const resolvePluginTargetUrl = (tradingSession, apiKey) => {
    const stored = tradingSession?.vm_url;
    if (stored && !isForbiddenFallbackUrl(stored)) {
        return stored.replace(/\/$/, "");
    }

    const mapped = getMappedVmUrlByApiKey(apiKey || tradingSession?.plugin_api_key);
    if (mapped) {
        logger.warn("[STOP-DIAG] vm_url missing or forbidden fallback — using API_KEY_VM_MAP", {
            sessionId: tradingSession?.python_session_id || null,
            storedVmUrl: stored || null,
            mappedVmUrl: mapped
        });
        return mapped;
    }

    if (process.env.PLUGIN_FORCE_LOCAL === "true") {
        return PLUGIN_BASE;
    }

    logger.warn("[STOP-DIAG] cannot resolve plugin VM — refusing plugin.mintzy.in / 18.205 fallback", {
        sessionId: tradingSession?.python_session_id || null,
        storedVmUrl: stored || null,
        hasPluginApiKey: Boolean(tradingSession?.plugin_api_key)
    });
    return null;
};

const getRoutingDebugInfo = (apiKey, tradingSession) => ({
    pluginBase: PLUGIN_BASE,
    pluginForceLocal: process.env.PLUGIN_FORCE_LOCAL === "true",
    pluginUseVmRouting: process.env.PLUGIN_USE_VM_ROUTING !== "false",
    apiKeyMapped: apiKey ? !!API_KEY_VM_MAP[normalizeApiKey(apiKey)] : null,
    autoAuthKey: apiKey ? shouldAutoAuthenticateApiKey(apiKey) : null,
    resolvedByApiKey: apiKey ? getMappedVmUrlByApiKey(apiKey) : null,
    storedVmUrl: tradingSession?.vm_url || null,
    pluginApiKeyPresent: Boolean(tradingSession?.plugin_api_key),
    resolvedBySession: tradingSession ? resolvePluginTargetUrl(tradingSession, apiKey) : null
});

const parseResponseBody = async (response) => {
    const text = await response.text();

    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

const parsePluginTarget = (url) => {
    try {
        const parsed = new URL(url);
        return {
            hostname: parsed.hostname || null,
            port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
            protocol: parsed.protocol || null
        };
    } catch {
        return { hostname: null, port: null, protocol: null };
    }
};

const getFetchFailureDetails = (err) => ({
    causeCode: err.cause?.code || err.code || null,
    causeErrno: err.cause?.errno || null,
    causeSyscall: err.cause?.syscall || null,
    causeAddress: err.cause?.address || null,
    causePort: err.cause?.port || null,
    causeMessage: err.cause?.message || null,
    causeName: err.cause?.name || null,
    errorName: err.name || null,
    errorMessage: err.message || null
});

const shouldStopDiag = (path, options) =>
    String(path || "").includes("stop-simulation") || options?.failOnError === false;

async function forwardToPlugin(path, method = "post", data = {}, headers = {}, params = {}, options = {}) {
    const hasExplicitTarget = Object.prototype.hasOwnProperty.call(options, "targetBaseUrl");
    if (hasExplicitTarget && !options.targetBaseUrl) {
        throw new AppError("Plugin VM URL is missing for this session", 502);
    }

    const base = options.targetBaseUrl || PLUGIN_BASE;
    if (hasExplicitTarget && isForbiddenFallbackUrl(base) && process.env.PLUGIN_FORCE_LOCAL !== "true") {
        throw new AppError("Refusing plugin.mintzy.in / 18.205 fallback for this session", 502);
    }

    const url = base.replace(/\/$/, "") + path;
    const h = { ...headers };

    if (PLUGIN_API_KEY && PLUGIN_API_KEY !== "changeme-plugin-api-key") {
        h["X-Plugin-Api-Key"] = PLUGIN_API_KEY;
    }

    const timeoutMs = options.timeoutMs || parseInt(process.env.PLUGIN_REQUEST_TIMEOUT || "60000", 10);
    const maxRetries = typeof options.retries === "number" ? options.retries : parseInt(process.env.PLUGIN_REQUEST_RETRIES || "2", 10);
    const failOnError = options.failOnError === undefined ? true : !!options.failOnError;

    for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt += 1) {
        const start = Date.now();

        try {
            const opts = {
                method,
                headers: h,
                signal: AbortSignal.timeout(timeoutMs)
            };

            if (data !== null && data !== undefined && method.toLowerCase() !== "get") {
                opts.body = typeof data === "string" ? data : JSON.stringify(data);
                if (!opts.headers["Content-Type"] && !opts.headers["content-type"]) {
                    opts.headers["Content-Type"] = "application/json";
                }
            }

            const query = new URLSearchParams(params || {});
            const response = await fetch(query.size ? `${url}?${query.toString()}` : url, opts);
            const responseData = options.responseType === "stream"
                ? Readable.fromWeb(response.body)
                : await parseResponseBody(response);
            const normalizedResponse = {
                status: response.status,
                headers: Object.fromEntries(response.headers.entries()),
                data: responseData
            };

            if (!response.ok) {
                const error = new Error(`Plugin returned status ${response.status}`);
                error.response = normalizedResponse;
                throw error;
            }

            const durationMs = Date.now() - start;
            logger.info(`[AngleOne Proxy] ${method.toUpperCase()} ${path} success`, {
                duration: durationMs,
                attempt,
                status: normalizedResponse.status
            });
            if (shouldStopDiag(path, options)) {
                logger.info("[STOP-DIAG] plugin request ok", {
                    method: method.toUpperCase(),
                    path,
                    url,
                    ...parsePluginTarget(url),
                    attempt,
                    maxRetries,
                    timeoutMs,
                    durationMs,
                    status: normalizedResponse.status
                });
            }

            return normalizedResponse;
        } catch (err) {
            const isClientError = err.response?.status >= 400 && err.response?.status < 500;
            const durationMs = Date.now() - start;
            const fetchFailure = getFetchFailureDetails(err);
            const target = parsePluginTarget(url);
            const willRetry = attempt < maxRetries && !isClientError;

            logger.warn(`[AngleOne Proxy] ${method.toUpperCase()} ${path} failed`, {
                url,
                duration: durationMs,
                attempt,
                timeoutMs,
                maxRetries,
                error: err.message,
                status: err.response?.status,
                details: err.response?.data,
                fetchFailure
            });
            if (shouldStopDiag(path, options)) {
                logger.warn("[STOP-DIAG] plugin request failed", {
                    method: method.toUpperCase(),
                    path,
                    url,
                    ...target,
                    attempt,
                    maxRetries,
                    timeoutMs,
                    durationMs,
                    failOnError,
                    willRetry,
                    status: err.response?.status || null,
                    ...fetchFailure
                });
            }

            if (willRetry) {
                await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
                continue;
            }

            if (failOnError) {
                const statusCode = err.response?.status || 502;
                const customErr = new AppError(`Plugin request failed at ${path}: ${err.message}`, statusCode);
                customErr.response = err.response;
                customErr.details = {
                    targetUrl: url,
                    timeoutMs,
                    attempt,
                    maxRetries,
                    durationMs,
                    ...target,
                    ...fetchFailure,
                    pluginBody: err.response?.data ?? null
                };
                throw customErr;
            }

            return null;
        }
    }

    return null;
}

export {
    forwardToPlugin,
    PLUGIN_BASE,
    getTargetBaseUrlByApiKey,
    resolvePluginTargetUrl,
    getRoutingDebugInfo,
    normalizeApiKey,
    shouldAutoAuthenticateApiKey
};

export default {
    forwardToPlugin,
    PLUGIN_BASE,
    getTargetBaseUrlByApiKey,
    resolvePluginTargetUrl,
    getRoutingDebugInfo,
    normalizeApiKey,
    shouldAutoAuthenticateApiKey
};
