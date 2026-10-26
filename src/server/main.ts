import { loadConfig } from "./config.js";
import { createKondo } from "./kondo.js";

const config = loadConfig();
const kondo = await createKondo(config);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    kondo.app.log.info({ signal }, "shutting down");
    await kondo.stop();
    process.exit(0);
  });
}

await kondo.start();
await kondo.app.listen({ host: config.host, port: config.port });
kondo.app.log.info({ version: config.version }, "kondo started");
