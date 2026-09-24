import { type Env, depsFromEnv, handleRequest } from "./lib/router";

export default {
  fetch(request, env) {
    return handleRequest(request, depsFromEnv(env));
  },
} satisfies ExportedHandler<Env>;
