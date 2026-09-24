import { depsFromEnv, type Env } from "./lib/env";
import { handleRequest } from "./lib/router";

export default {
  fetch(request, env) {
    return handleRequest(request, depsFromEnv(env));
  },
} satisfies ExportedHandler<Env>;
