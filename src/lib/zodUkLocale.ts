import { z } from "zod";

// Ukrainian validation messages for all Zod schemas (fieldErrors in 400s).
// Applied once on import; apiResponse.ts (imported by every route) loads it.
z.config(z.locales.uk());

export {};
