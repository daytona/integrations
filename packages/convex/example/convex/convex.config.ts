import { defineApp } from "convex/server";
import { v } from "convex/values";
import daytona from "@daytona/convex/convex.config.js";

const app = defineApp({
  env: { DAYTONA_API_KEY: v.string() },
});

// Components can't read the app's env vars, so pass the key down. Passing it
// by reference means the component always sees the current value.
app.use(daytona, {
  env: { DAYTONA_API_KEY: app.env.DAYTONA_API_KEY },
});

export default app;
