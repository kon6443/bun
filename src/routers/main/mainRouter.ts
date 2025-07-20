import express from "express";
import { Request, Response } from "express";
import { oracleAutonomousRepository } from "../../repositories/oracleAutonomousRepository";

const mainRouter = express.Router();

mainRouter.get("/", (req: Request, res: Response) => {
  const status = 200;
  res.status(status).json({ message: "SUCCESS" });
});

mainRouter.get("/health-check", async (req: Request, res: Response) => {
  const sql = "SELECT * FROM users";
  console.log("health-check router:", sql);
  const users = await oracleAutonomousRepository.execute(sql);
  console.log("users:", users);
  const status = 200;
  res.status(status).json({ message: "CONNECTION HEALTHY" });
});

export default mainRouter;
