import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract";
import { queryTrails } from "./client";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    query: ({ serverUrl, repoPaths, ...query }, context) => queryTrails(query, serverUrl,
      AbortSignal.any([context.signal, context.lifecycle.signal]), { repoPaths }),
  },
});
