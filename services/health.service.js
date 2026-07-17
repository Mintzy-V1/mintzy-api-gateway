

export const getHealthStatus = () => {

    return {

        success:true,
        message:"Service is up and running",
        status:"healthy",
        uptime:process.uptime(),
        environment:process.env.NODE_ENV,
        version:process.env.npm_package_version,
        timestamp: new Date().toISOString()

    }
};

export const getReadinessStatus = ()=>{

    return {
        success:true,
        status:"ready",
        checks:{
            database:process.env.MONGO_URI ? "connected" : "not-configured",
            redis:"not-configured",
            queue:"not-configured",
        },
        timestamp: new Date().toISOString()
    };
    
};
