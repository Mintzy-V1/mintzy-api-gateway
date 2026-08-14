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

const passthroughSchema = createSchema((value) => ({ value }));

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

const submitCredentialsSchema = passthroughSchema;
const submitTotpSchema = passthroughSchema;
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

const pluginValidation = {
    sessionIdParamSchema: passthroughSchema,
    savedConfigurationParamSchema: passthroughSchema,
    savedConfigurationBodySchema: passthroughSchema,
    savedConfigurationUpdateSchema: passthroughSchema,
    livePnlParamSchema: passthroughSchema,
    livePnlHistoryQuerySchema: passthroughSchema,
    idParamSchema: passthroughSchema,
    submitCredentialsSchema,
    submitTotpSchema,
    startTradingSchema,
    startSimulationSchema,
    stopSimulationSchema,
    stopTradingByBodySchema,
    mongoIdParamSchema: passthroughSchema,
    dashboardQuerySchema: passthroughSchema,
    pnlQuerySchema: passthroughSchema,
    userPnlQuerySchema: passthroughSchema,
    sessionStateQuerySchema: passthroughSchema,
    exitSymbolParamSchema: passthroughSchema
};

export default pluginValidation;
