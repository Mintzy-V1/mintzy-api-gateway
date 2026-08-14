

import express from 'express';

import corsMiddleware from "./config/cors.js";

import apiRoutes from "./index.js";


const app = express();


app.use(express.json());

app.use(corsMiddleware);

app.use("/api/v1", apiRoutes);

app.use((err, _req, res, _next) => {
    const statusCode = err.statusCode || err.status || 500;

    if (statusCode >= 400) {
        console.error("[API Error]", {
            message: err.message,
            statusCode,
            details: err.details || err.response?.data
        });
    }

    res.status(statusCode).json({
        success: false,
        message: err.message || "Internal Server Error",
        details: err.details || err.response?.data
    });
});

export default app;
