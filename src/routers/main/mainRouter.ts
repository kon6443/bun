import express from "express";
import { Request, Response } from "express";
import { oracleAutonomousRepository } from "../../repositories/oracleAutonomousRepository";

const mainRouter = express.Router();

mainRouter.get("/", (req: Request, res: Response) => {
  const status = 200;
  res.status(status).json({ message: "SUCCESS" });
});

mainRouter.get("/health-check", async (req: Request, res: Response) => {
  // const rrr = await oracleAutonomousRepository.execute(sql);
  const status = 200;
  res.status(status).json({ message: "CONNECTION HEALTHY" });
});

export default mainRouter;
