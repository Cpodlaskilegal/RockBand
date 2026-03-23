import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? "0.0.0.0";
const { app } = createApp();

app
  .listen({ port, host })
  .then(() => {
    console.log(`Hosted Symphony control plane listening on http://${host}:${port}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
