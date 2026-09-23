import { defineApp } from "convex/server";
import daytona from "@daytona/convex/convex.config.js";

const app = defineApp();
app.use(daytona);

export default app;
