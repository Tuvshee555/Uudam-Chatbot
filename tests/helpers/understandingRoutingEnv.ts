import { applyTestEnv } from "./env";

/**
 * Import this FIRST in a test that imports src modules which read the environment when they load
 * (the selection and clarification stores). ES imports run in order, so the environment is in place
 * before those modules are evaluated, however the test runner was started.
 */
applyTestEnv({ REDIS_STATE_ENABLED: "false" });
