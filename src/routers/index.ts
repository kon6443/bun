import express, { Request, Response, NextFunction } from "express";
import mainRouter from "./main/index";
import utilServiceInstance from "../services/utils";

async function userCheckMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        console.log(req.cookies);
        // const user = ;
        // req.headers['user'] = user;
        next();
    } catch (error) {
        // throw new Error("User check failed");
        utilServiceInstance.handleError({
            message: "INTERNAL_SERVER_ERROR WHILE CHECKING USER",
            status: 500,
        });
    }
}

const router = express.Router();

// router.use(userCheckMiddleware);

router.use("/", mainRouter);

export default router;
