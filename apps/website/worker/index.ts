import { depsFromEnv, type Env, handleRequest } from "./lib/router";

export default {
  fetch(request, env) {
    return handleRequest(request, depsFromEnv(env));
  },
} satisfies ExportedHandler<Env>;
