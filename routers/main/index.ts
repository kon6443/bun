import express from "express";

import mainRouter from "./mainRouter";

const router = express.Router();

router.use("/", mainRouter);

export default router;
