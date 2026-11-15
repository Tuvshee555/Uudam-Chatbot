import { applyTestEnv } from "./env";

/** Imported first by tests whose modules read the server environment when they load. */
applyTestEnv({});
