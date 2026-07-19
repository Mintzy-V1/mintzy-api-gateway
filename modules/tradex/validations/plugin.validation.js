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
    const sessionError = requireString(body.session_id, "Session ID is required");

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

const passthroughSchema = createSchema((value) => ({ value }));

const pluginValidation = {
    submitCredentialsSchema,
    submitTotpSchema,
    startTradingSchema,
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
