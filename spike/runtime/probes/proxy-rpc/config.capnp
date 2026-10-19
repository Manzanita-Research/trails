using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "main", worker = .probe), (name = "disk", disk = (writable = true)) ],
  sockets = [ (name = "http", address = "127.0.0.1:0", http = (), service = "main") ],
);

const probe :Workerd.Worker = (
  modules = [ (name = "index.js", esModule = embed "index.js") ],
  compatibilityDate = "2026-08-31",
  compatibilityFlags = ["nodejs_compat"],
  durableObjectNamespaces = [
    (className = "NoCtor", uniqueKey = "NoCtor", enableSql = true),
    (className = "CtorOnly", uniqueKey = "CtorOnly", enableSql = true),
    (className = "CtorBcw", uniqueKey = "CtorBcw", enableSql = true),
    (className = "Proxied", uniqueKey = "Proxied", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "disk"),
  bindings = [
    (name = "NoCtor", durableObjectNamespace = "NoCtor"),
    (name = "CtorOnly", durableObjectNamespace = "CtorOnly"),
    (name = "CtorBcw", durableObjectNamespace = "CtorBcw"),
    (name = "Proxied", durableObjectNamespace = "Proxied"),
  ],
);
