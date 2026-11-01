import { defineApp } from "convex/server";
import { v } from "convex/values";
import packageRegistryNpm from "jive-resource-connector-package-registry-npm/convex.config.js";
import accountKeys from "./components/accountKeys/convex.config.js";

const app = defineApp({
  env: {
    // Unset, the npm connector acts on https://registry.npmjs.org; tests point it at a fake registry.
    NPM_REGISTRY_URL: v.optional(v.string()),
    // Unset, sealing fails closed. Optional so a push succeeds before the deployment has a key.
    CONNECTION_KEY: v.optional(v.string()),
  },
});
app.use(packageRegistryNpm, { env: { NPM_REGISTRY_URL: app.env.NPM_REGISTRY_URL } });
app.use(accountKeys, { env: { CONNECTION_KEY: app.env.CONNECTION_KEY } });

export default app;
