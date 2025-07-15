import express from "express";
import mainRouter from "./main/index";

const router = express.Router();

router.use("/", mainRouter);

export default router;
