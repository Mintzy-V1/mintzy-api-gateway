import { Router } from "express";
import { updateBroker, onboard, getUser, getUserPlan, refreshToken } from "../controller/user.controller.js";

const router = Router();

router.post("/broker", updateBroker);
router.post("/onboard", onboard);
router.post("/refresh", refreshToken);
router.post("/plan", getUserPlan);

router.get("/detail",getUser);

export default router;
