import express from "express";
import mainRouter from "./main/index";

const router = express.Router();

// pb
router.use("/", mainRouter);

export default router;
