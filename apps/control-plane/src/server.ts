import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 4310);
const { app } = createApp();

app
  .listen({ port, host: "127.0.0.1" })
  .then(() => {
    console.log(`Hosted Symphony control plane listening on http://127.0.0.1:${port}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
