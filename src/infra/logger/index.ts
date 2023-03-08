import { createLogger } from "./logger";
import { PORT_ENV } from "../../const";

export const log = {
  alert: createLogger({ webhook: PORT_ENV.ALERT_WEBHOOK_URL, level: "warn" }),
  trace: createLogger({ webhook: PORT_ENV.TRACE_WEBHOOK_URL, level: "warn" }),
  common: createLogger({
    webhook: PORT_ENV.HEARTBEAT_WEBHOOK_URL,
    level: "warn",
  }),
};
