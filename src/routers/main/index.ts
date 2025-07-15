import express from "express";

import mainRouter from "./mainRouter";
import discordRouter from "./discordRouter";

const router = express.Router();

router.use("/", mainRouter);
router.use("/discord", discordRouter);

export default router;
