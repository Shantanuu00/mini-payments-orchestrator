import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

await app.register(swagger, {
  openapi: {
    info: {
      title: "Mini Payment Orchestrator API",
      version: "0.1.0",
    },
  },
});
await app.register(swaggerUI, { routePrefix: "/docs" });

app.get("/health", async () => ({ ok: true }));

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });