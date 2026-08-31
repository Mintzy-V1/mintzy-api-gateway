const normalizeSymbolKey = (value) => {
    if (typeof value !== "string" || value.trim() === "") return "";
    return value.trim().toUpperCase();
};

const normalizeStopLoss = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0.05;
    if (parsed > 1) return parsed / 100;
    return parsed;
};

const normalizePluginSymbol = (entry) => {
    const symbol = normalizeSymbolKey(entry?.symbol || entry?.ticker);
    const capital = Number(entry?.capital);

    if (!symbol || !Number.isFinite(capital) || capital <= 0) {
        return null;
    }

    return {
        symbol,
        capital,
        stop_loss: normalizeStopLoss(entry?.stop_loss ?? 0.05)
    };
};

const resolvePluginSymbols = (configuration = {}) => {
    const rawSymbols = Array.isArray(configuration.symbols) ? configuration.symbols : [];
    const rawAlphas = Array.isArray(configuration.alphas) ? configuration.alphas : [];
    const source = rawSymbols.length > 0 ? rawSymbols : rawAlphas;

    return source.map(normalizePluginSymbol).filter(Boolean);
};

const resolveLeverageMultiplier = (...candidates) => {
    for (const value of candidates) {
        if (value === undefined || value === null || value === "") continue;
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
        }
    }

    return null;
};

const buildSimulationStartPayload = (
    configuration = {},
    runtimeOverrides = {},
    session_id,
    { saved_configuration_id, leverage_multiplier } = {}
) => {
    const merged = { ...configuration, ...runtimeOverrides };
    const symbols = resolvePluginSymbols(merged);
    const configurationId =
        saved_configuration_id
        || merged.configuration_id
        || merged.saved_configuration_id
        || null;

    const payload = {
        session_id,
        strategy: "B",
        symbols,
        time_frame: merged.time_frame || "3 hours",
        use_broker_cash: false
    };

    if (merged.candle != null && String(merged.candle).trim() !== "") {
        payload.candle = String(merged.candle).trim();
    }

    if (configurationId) {
        payload.configuration_id = String(configurationId);
    }

    const resolvedLeverage = resolveLeverageMultiplier(
        runtimeOverrides.leverage_multiplier,
        runtimeOverrides.leverageMultiplier,
        leverage_multiplier,
        merged.leverage_multiplier,
        merged.leverageMultiplier
    );

    if (resolvedLeverage != null) {
        payload.leverage_multiplier = resolvedLeverage;
    }

    return payload;
};

const PLUGIN_SIMULATION_START_SCHEMA = {
    session_id: "string (required)",
    strategy: "string — gateway sends B; plugin forces B",
    symbols: "array of { symbol, capital, stop_loss }",
    time_frame: "string — default '3 hours'",
    use_broker_cash: "boolean — gateway sends false for simulation",
    candle: "string (optional)",
    configuration_id: "string (optional) — Mongo SavedTradingConfiguration _id",
    leverage_multiplier: "number (optional) — root SavedTradingConfiguration.leverage_multiplier or request override"
};

const summarizeSimulationStartPayload = (payload = {}) => ({
    session_id: payload.session_id,
    strategy: payload.strategy,
    configuration_id: payload.configuration_id || null,
    saved_configuration_id_mapped: Boolean(payload.configuration_id),
    time_frame: payload.time_frame,
    use_broker_cash: payload.use_broker_cash,
    candle: payload.candle ?? null,
    leverage_multiplier: payload.leverage_multiplier ?? null,
    symbol_count: Array.isArray(payload.symbols) ? payload.symbols.length : 0,
    symbols: Array.isArray(payload.symbols)
        ? payload.symbols.map((entry) => ({
            symbol: entry?.symbol,
            capital: entry?.capital,
            stop_loss: entry?.stop_loss
        }))
        : []
});

const checkSimulationStartPayloadCompatibility = (payload = {}) => {
    const issues = [];

    if (!payload.session_id || typeof payload.session_id !== "string") {
        issues.push("session_id must be a non-empty string");
    }
    if (!Array.isArray(payload.symbols) || payload.symbols.length === 0) {
        issues.push("symbols must be a non-empty array");
    } else {
        for (const [index, entry] of payload.symbols.entries()) {
            if (!entry?.symbol) issues.push(`symbols[${index}].symbol missing`);
            if (!Number.isFinite(Number(entry?.capital)) || Number(entry.capital) <= 0) {
                issues.push(`symbols[${index}].capital must be > 0`);
            }
        }
    }
    if (payload.strategy && payload.strategy !== "B") {
        issues.push(`strategy is "${payload.strategy}" — plugin start-simulation forces B anyway`);
    }
    if (payload.configuration_id != null && typeof payload.configuration_id !== "string") {
        issues.push("configuration_id must be a string when provided");
    }
    if (payload.saved_configuration_id != null) {
        issues.push(
            "gateway inbound field saved_configuration_id must be mapped to configuration_id before plugin call"
        );
    }
    if (
        payload.leverage_multiplier != null
        && (!Number.isFinite(Number(payload.leverage_multiplier)) || Number(payload.leverage_multiplier) < 0)
    ) {
        issues.push("leverage_multiplier must be a number >= 0 when provided");
    }

    return {
        compatible: issues.length === 0,
        issues,
        plugin_expects: PLUGIN_SIMULATION_START_SCHEMA,
        outbound_payload: summarizeSimulationStartPayload(payload)
    };
};

const buildLiveTradingStartPayload = (
    configuration = {},
    runtimeOverrides = {},
    session_id,
    { saved_configuration_id, savedConfigurationId, leverage_multiplier } = {}
) => {
    const merged = { ...configuration, ...runtimeOverrides };
    const symbols = resolvePluginSymbols(merged);
    const configurationId =
        saved_configuration_id
        || savedConfigurationId
        || merged.configuration_id
        || merged.saved_configuration_id
        || null;

    const payload = {
        session_id,
        strategy: merged.strategy || "C",
        symbols,
        time_frame: merged.time_frame || "3 hours",
        use_broker_cash: merged.use_broker_cash !== false
    };

    if (merged.candle != null && String(merged.candle).trim() !== "") {
        payload.candle = String(merged.candle).trim();
    }

    if (configurationId) {
        payload.configuration_id = String(configurationId);
    }

    const resolvedLeverage = resolveLeverageMultiplier(
        runtimeOverrides.leverage_multiplier,
        runtimeOverrides.leverageMultiplier,
        leverage_multiplier,
        merged.leverage_multiplier,
        merged.leverageMultiplier
    );

    if (resolvedLeverage != null) {
        payload.leverage_multiplier = resolvedLeverage;
    }

    return payload;
};

export {
    normalizeSymbolKey,
    normalizeStopLoss,
    normalizePluginSymbol,
    resolvePluginSymbols,
    buildSimulationStartPayload,
    buildLiveTradingStartPayload,
    PLUGIN_SIMULATION_START_SCHEMA,
    summarizeSimulationStartPayload,
    checkSimulationStartPayloadCompatibility
};
