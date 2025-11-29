import express, { Request, Response } from "express";
import teamControllerInstance from "../../controllers/teamController";

const teamRouter = express.Router();

const extractUserId = (req: Request): number | undefined => {
  const headerUserId = req.header("x-user-id");
  const queryUserId = req.query.userId;

  const rawUserId = headerUserId
    ? headerUserId
    : Array.isArray(queryUserId)
    ? queryUserId[0]
    : queryUserId;

  if (!rawUserId) return undefined;

  const parsed = Number(rawUserId);
  return Number.isNaN(parsed) ? undefined : parsed;
};

teamRouter.get("/", async (req: Request, res: Response) => {
  const userId = extractUserId(req);
  const teams = await teamControllerInstance.getMyTeams({ userId });
  res.status(200).json({ data: teams });
});

export default teamRouter;

