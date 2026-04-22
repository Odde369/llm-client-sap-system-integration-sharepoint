const fastify = require("fastify")({ logger: false });
const fastifyStatic = require("@fastify/static");
const path = require("path");

const PORT = +(process.env.PORT || "3300");

fastify.register(fastifyStatic, {
  root: path.join(__dirname, "dist"),
  prefix: "/",
  setHeaders: (res) => {
    // Required by sandpack: allow iframe embedding and cross-origin requests
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  },
});

// SPA fallback
fastify.setNotFoundHandler((req, reply) => {
  return reply.sendFile("index.html", { cacheControl: false });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    process.exit(1);
  }
  console.log(`sandpack-bundler-mirror listening on ${address}`);
});
