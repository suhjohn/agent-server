import { Router, Request, Response } from "express";
import { checkDatabaseConnection } from "../db/connection";

const router: Router = Router();

router.get("/", async (_req: Request, res: Response) => {
  return res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION || "1.0.0",
    database: {
      connected: await checkDatabaseConnection(),
    },
  });
});

export default router;
