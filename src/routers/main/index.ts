import express from "express";

import mainRouter from "./mainRouter";
import authRouter from "./authRouter";
import discordRouter from "./discordRouter";
import teamRouter from "./teamRouter";

const router = express.Router();

router.use("/", mainRouter);
router.use("/auth", authRouter);
router.use("/discord", discordRouter);
router.use("/teams", teamRouter);

export default router;
