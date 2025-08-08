import express from "express";

import mainRouter from "./mainRouter";
import authRouter from "./authRouter";
import discordRouter from "./discordRouter";

const router = express.Router();

router.use("/", mainRouter);
router.use("/auth", authRouter);
router.use("/discord", discordRouter);

export default router;
