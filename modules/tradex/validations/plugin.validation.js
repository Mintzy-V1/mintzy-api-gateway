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
    const accessKey = body.access_key || body.accessKey;
    const accessSecret = body.access_secret || body.accessSecret;
    const errors = [
        requireString(body.userId, "User ID is required"),
        requireString(accessKey, "Access key is required"),
        requireString(accessSecret, "Access secret is required")
    ].filter(Boolean);

    if (errors.length > 0) {
        return { error: validationError(errors.join(", ")) };
    }

    return {
        value: {
            ...body,
            userId: body.userId.trim(),
            access_key: accessKey.trim(),
            access_secret: accessSecret.trim()
        }
    };
});

const submitTotpSchema = createSchema((body) => {
    const sessionError = requireString(body.session_id, "Session ID is required");

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

const stopTradingByBodySchema = createSchema((body) => {
    const sessionError = requireString(body.session_id, "Session ID is required");

    if (sessionError) {
        return { error: validationError(sessionError) };
    }

    return { value: body };
});

const passthroughSchema = createSchema((value) => ({ value }));

const pluginValidation = {
    submitCredentialsSchema,
    submitTotpSchema,
    startTradingSchema,
    startSimulationSchema,
    stopSimulationSchema,
    updateLeverageMultiplierSchema,
    stopTradingByBodySchema,
    sessionIdParamSchema: passthroughSchema,
    idParamSchema: passthroughSchema,
    mongoIdParamSchema: passthroughSchema,
    dashboardQuerySchema: passthroughSchema,
    pnlQuerySchema: passthroughSchema,
    userPnlQuerySchema: passthroughSchema,
    sessionStateQuerySchema: passthroughSchema,
    exitSymbolParamSchema: passthroughSchema,
    livePnlParamSchema: passthroughSchema,
    livePnlHistoryQuerySchema: passthroughSchema,
    savedConfigurationBodySchema: passthroughSchema,
    savedConfigurationUpdateSchema: passthroughSchema,
    savedConfigurationParamSchema: passthroughSchema
};

export default pluginValidation;
