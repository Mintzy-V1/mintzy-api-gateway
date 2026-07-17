const createSchema = () => ({
    validate(value) {
        return {
            error: null,
            value: value || {}
        };
    }
});

const pluginValidation = {
    sessionIdParamSchema: createSchema(),
    savedConfigurationParamSchema: createSchema(),
    savedConfigurationBodySchema: createSchema(),
    savedConfigurationUpdateSchema: createSchema(),
    livePnlParamSchema: createSchema(),
    livePnlHistoryQuerySchema: createSchema(),
    idParamSchema: createSchema(),
    submitCredentialsSchema: createSchema(),
    submitTotpSchema: createSchema(),
    startTradingSchema: createSchema(),
    stopTradingByBodySchema: createSchema(),
    mongoIdParamSchema: createSchema(),
    dashboardQuerySchema: createSchema(),
    pnlQuerySchema: createSchema(),
    userPnlQuerySchema: createSchema(),
    sessionStateQuerySchema: createSchema(),
    exitSymbolParamSchema: createSchema()
};

export default pluginValidation;
