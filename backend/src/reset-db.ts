import { resetDatabase } from "./db.js";

await resetDatabase();
console.log("Database reset and reseeded.");
