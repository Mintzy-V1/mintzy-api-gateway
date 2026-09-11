const validationError = (message) => ({
    details: [{ message }]
});

const createSchema = (validator) => ({
    validate(value = {}) {
        const result = validator(value || {});

        if (result.error) {
            return result;
        }

        return {
            error: null,
            value: result.value ?? value ?? {}
        };
    }
});

const requireString = (value, message) => {
    if (typeof value !== "string" || value.trim() === "") {
        return message;
    }

    return null;
};

const requireMongoId = (value, message) => {
    const stringError = requireString(value, message);
    if (stringError) return stringError;

    if (!/^[a-fA-F0-9]{24}$/.test(value.trim())) {
        return message;
    }

    return null;
};

const submitCredentialsSchema = createSchema((body) => {
    const errors = [
        requireString(body.userId, "User ID is required"),
        requireString(body.api_key, "API key is required"),
        requireString(body.client_code, "Client code is required"),
        requireString(body.password, "Password is required"),
        requireString(body.vendor_code, "Vendor code is required")
    ].filter(Boolean);

    if (body.base_url !== undefined && body.base_url !== null && typeof body.base_url !== "string") {
        errors.push("Base URL must be a string");
    }

    if (errors.length > 0) {
        return { error: validationError(errors.join(", ")) };
    }

    return {
        value: {
            ...body,
            userId: body.userId.trim(),
            api_key: body.api_key.trim(),
            client_code: body.client_code.trim(),
            password: body.password.trim(),
            vendor_code: body.vendor_code.trim(),
            base_url: body.base_url?.trim() || body.base_url
        }
    };
});

const submitTotpSchema = createSchema((body) => {
    const sessionError = requireString(body.session_id || body.sessionId, "Session ID is required");
    if (sessionError) {
        return { error: validationError(sessionError) };
    }
    return { value: body };
});

const startTradingSchema = createSchema((body) => {
    const sessionError = requireString(body.session_id || body.sessionId, "Session ID is required");
    if (sessionError) {
        return { error: validationError(sessionError) };
    }
    return { value: body };
});

const startSimulationSchema = createSchema((body) => {
    const sessionError = requireString(body.session_id || body.sessionId, "Session ID is required");
    const savedConfigError = requireMongoId(
        body.saved_configuration_id || body.savedConfigurationId,
        "saved_configuration_id is required"
    );

    const errors = [sessionError, savedConfigError].filter(Boolean);
    if (errors.length > 0) {
        return { error: validationError(errors.join(", ")) };
    }

    return { value: body };
});

const stopSimulationSchema = createSchema((body) => {
    const sessionError = requireString(body.session_id || body.sessionId, "Session ID is required");

    if (sessionError) {
        return { error: validationError(sessionError) };
    }

    return { value: body };
});

const stopTradingByBodySchema = createSchema((body) => {
    const sessionError = requireString(body.session_id, "Session ID is required");
    if (sessionError) {
        return { error: validationError(sessionError) };
    }
    return { value: body };
});

const updateLeverageMultiplierSchema = createSchema((body) => {
    const configurationId = body.configuration_id || body.configurationId || body.saved_configuration_id;
    const leverageMultiplier = body.leverage_multiplier ?? body.leverageMultiplier;

    const configError = requireMongoId(configurationId, "configuration_id is required");
    if (configError) {
        return { error: validationError(configError) };
    }

    if (leverageMultiplier === undefined || leverageMultiplier === null || leverageMultiplier === "") {
        return { error: validationError("leverage_multiplier is required") };
    }

    const parsed = Number(leverageMultiplier);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return { error: validationError("leverage_multiplier must be a number greater than or equal to 0") };
    }

    return {
        value: {
            ...body,
            configuration_id: String(configurationId).trim(),
            leverage_multiplier: parsed
        }
    };
});

const passthroughSchema = createSchema((value) => ({ value }));

const tradingLogsQuerySchema = createSchema((query) => {
    const value = { ...query };

    if (value.limit !== undefined && value.limit !== null && value.limit !== "") {
        const parsed = Number(value.limit);
        if (!Number.isFinite(parsed)) {
            return { error: validationError("Limit must be a number") };
        }
        value.limit = parsed;
    }

    return { value };
});

const pluginValidation = {
    submitCredentialsSchema,
    submitTotpSchema,
    startTradingSchema,
    startSimulationSchema,
    stopSimulationSchema,
    stopTradingByBodySchema,
    updateLeverageMultiplierSchema,
    sessionIdParamSchema: passthroughSchema,
    userIdParamSchema: passthroughSchema,
    tradingLogsQuerySchema,
    savedConfigurationParamSchema: passthroughSchema,
    savedConfigurationBodySchema: passthroughSchema,
    savedConfigurationUpdateSchema: passthroughSchema,
    livePnlParamSchema: passthroughSchema,
    livePnlHistoryQuerySchema: passthroughSchema,
    idParamSchema: passthroughSchema,
    mongoIdParamSchema: passthroughSchema,
    dashboardQuerySchema: passthroughSchema,
    pnlQuerySchema: passthroughSchema,
    userPnlQuerySchema: passthroughSchema,
    sessionStateQuerySchema: passthroughSchema,
    exitSymbolParamSchema: passthroughSchema
};

export default pluginValidation;
