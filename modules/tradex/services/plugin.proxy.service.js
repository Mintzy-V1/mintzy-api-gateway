import { Readable } from "stream";
import logger from "../config/logger.js";
import AppError from "../utils/AppError.js";

// const PLUGIN_BASE = process.env.TRADEX_PLUGIN_BASE_URL || process.env.PLUGIN_BASE_URL || "https://32.198.166.49:8000";
const PLUGIN_API_KEY = process.env.PLUGIN_API_KEY || "changeme-plugin-api-key";

const PLUGIN_BASE = "http://32.198.166.49:8000"

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

const getTargetBaseUrlByApiKey = (apiKey) => {
    if (process.env.PLUGIN_FORCE_LOCAL === "true") {
        return PLUGIN_BASE;
    }

    const useVmRouting = process.env.PLUGIN_USE_VM_ROUTING !== "false";
    const normalizedApiKey = normalizeApiKey(apiKey);

    if (useVmRouting && API_KEY_VM_MAP[normalizedApiKey]) {
        return API_KEY_VM_MAP[normalizedApiKey];
    }

    return PLUGIN_BASE;
};

const resolvePluginTargetUrl = (tradingSession) => tradingSession?.vm_url || PLUGIN_BASE;

const getRoutingDebugInfo = (apiKey, tradingSession) => ({
    pluginBase: PLUGIN_BASE,
    pluginForceLocal: process.env.PLUGIN_FORCE_LOCAL === "true",
    pluginUseVmRouting: process.env.PLUGIN_USE_VM_ROUTING !== "false",
    apiKeyMapped: apiKey ? !!API_KEY_VM_MAP[normalizeApiKey(apiKey)] : null,
    autoAuthKey: apiKey ? shouldAutoAuthenticateApiKey(apiKey) : null,
    resolvedByApiKey: apiKey ? getTargetBaseUrlByApiKey(apiKey) : null,
    storedVmUrl: tradingSession?.vm_url || null,
    resolvedBySession: tradingSession ? resolvePluginTargetUrl(tradingSession) : null
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

const getFetchFailureDetails = (err) => ({
    causeCode: err.cause?.code,
    causeMessage: err.cause?.message,
    causeName: err.cause?.name,
    errorName: err.name,
    errorMessage: err.message
});

async function forwardToPlugin(path, method = "post", data = {}, headers = {}, params = {}, options = {}) {
    const base = options.targetBaseUrl || PLUGIN_BASE;
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
            const headersObject = Object.fromEntries(response.headers.entries());
            const responseType = options.responseType || "json";
            const responseData = responseType === "stream"
                ? Readable.fromWeb(response.body)
                : await parseResponseBody(response);

            const normalizedResponse = {
                status: response.status,
                headers: headersObject,
                data: responseData
            };

            if (!response.ok) {
                const error = new Error(`Plugin returned status ${response.status}`);
                error.response = normalizedResponse;
                throw error;
            }

            logger.info(`[TradeX Proxy] ${method.toUpperCase()} ${path} success`, {
                duration: Date.now() - start,
                attempt,
                status: normalizedResponse.status
            });

            return normalizedResponse;
        } catch (err) {
            const isClientError = err.response?.status >= 400 && err.response?.status < 500;

            logger.warn(`[TradeX Proxy] ${method.toUpperCase()} ${path} failed`, {
                url,
                duration: Date.now() - start,
                attempt,
                error: err.message,
                status: err.response?.status,
                details: err.response?.data,
                fetchFailure: getFetchFailureDetails(err)
            });

            if (attempt < maxRetries && !isClientError) {
                await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
                continue;
            }

            if (failOnError) {
                const statusCode = err.response?.status || 502;
                const customErr = new AppError(`Plugin request failed at ${path}: ${err.message}`, statusCode);
                customErr.response = err.response;
                customErr.details = err.response?.data || {
                    targetUrl: url,
                    ...getFetchFailureDetails(err)
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
