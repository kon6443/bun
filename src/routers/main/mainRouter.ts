import express from "express";
import { Request, Response } from "express";

const mainRouter = express.Router();

mainRouter.get("/", (req: Request, res: Response) => {
  const status = 200;
  res.status(status).json({ message: "SUCCESS" });
});

mainRouter.get("/health-check", (req: Request, res: Response) => {
  const status = 200;
  res.status(status).json({ message: "CONNECTION HEALTHY" });
});

export default mainRouter;
