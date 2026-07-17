

import {Router} from "express";

import {healthCheck , readinessCheck} from "../controller/health.controller.js";

const router = Router();

router.get("/health" ,healthCheck);

router.get("/ready" , readinessCheck);

export default router;

