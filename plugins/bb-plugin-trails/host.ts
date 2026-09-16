import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract";
import { queryTrails } from "./client";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    query: ({ serverUrl, ...query }, context) => queryTrails(query, serverUrl,
      AbortSignal.any([context.signal, context.lifecycle.signal])),
  },
});
