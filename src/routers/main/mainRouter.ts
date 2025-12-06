import express from "express";
import { Request, Response } from "express";
import { AppDataSource } from "../../database/data-source";
import { User } from "../../entities/User";

const mainRouter = express.Router();

mainRouter.get("/", (req: Request, res: Response) => {
  const status = 200;
  res.status(status).json({ message: "SUCCESS" });
});

mainRouter.get("/health-check", async (req: Request, res: Response) => {
  const userRepository = AppDataSource.getRepository(User);
  const users = await userRepository.find();
  console.log("users:", users);
  const status = 200;
  res.status(status).json({ message: "CONNECTION HEALTHY" });
});

export default mainRouter;
