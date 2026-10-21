"use strict";
// Local / self-hosted entry point. On Vercel, api/index.js serves the same app instead.
const app = require("./app");

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`CRM running on http://localhost:${PORT}`));
