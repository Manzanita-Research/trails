// Four Durable Object classes, each answering the RPC method `hello`. Only
// `Proxied` differs in a way that matters: like alchemy's
// DurableObjectBridge, its constructor returns a Proxy that answers method
// names the class does not declare.
import { DurableObject } from "cloudflare:workers";

export class NoCtor extends DurableObject {
  async hello(x) {
    return `noctor:${x}`;
  }
}

export class CtorOnly extends DurableObject {
  constructor(state, env) {
    super(state, env);
  }
  async hello(x) {
    return `ctoronly:${x}`;
  }
}

export class CtorBcw extends DurableObject {
  #ready;
  constructor(state, env) {
    super(state, env);
    this.#ready = state.blockConcurrencyWhile(async () => 1);
  }
  async hello(x) {
    await this.#ready;
    return `ctorbcw:${x}`;
  }
}

export class Proxied extends DurableObject {
  constructor(state, env) {
    super(state, env);
    return new Proxy(this, {
      get: (target, prop) => {
        if (typeof prop !== "string" || prop in target) {
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args) => `proxied:${prop}:${args[0]}`;
      },
    });
  }
}

export default {
  async fetch(request, env) {
    const which = new URL(request.url).pathname.slice(1);
    try {
      return Response.json(await env[which].getByName("a").hello("hi"));
    } catch (error) {
      return new Response(
        String(error?.stack ?? error)
          .split("\n")
          .slice(0, 2)
          .join(" | "),
        {
          status: 500,
        },
      );
    }
  },
};
