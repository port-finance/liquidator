import * as pino from "pino";
import { PORT_ENV } from "../const";

class logSlack implements pino.DestinationStream {
  constructor(private hook: string) {}

  write(msg: string): void {
    console.log(msg);
    fetch(this.hook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: msg }),
    })
      .then(() => true)
      .catch((e) => {
        console.error(`Err pushing to remote logging service: ${e}`);
        return false;
      });
  }
}

export const alertLogger = pino.pino(
  {
    timestamp: () => {
      return `,"time":"${new Date().toISOString()}"`;
    },
    formatters: {
      bindings: (bindings: pino.Bindings) => {
        bindings;
        return {};
      },
    },
  },
  pino.multistream([
    {
      stream: PORT_ENV.ALERT_WEBHOOK_URL
        ? new logSlack(PORT_ENV.ALERT_WEBHOOK_URL)
        : pino.destination(2),
      level: "warn",
    },
    {
      stream: pino.destination(1),
    },
  ])
);

export const traceLogger = pino.pino(
  {
    level: "info",
    timestamp: () => {
      return `,"time":"${new Date().toISOString()}"`;
    },
    formatters: {
      bindings: (bindings: pino.Bindings) => {
        bindings;
        return {};
      },
    },
  },
  pino.multistream([
    {
      stream: PORT_ENV.TRACE_WEBHOOK_URL
        ? new logSlack(PORT_ENV.TRACE_WEBHOOK_URL)
        : pino.destination(2),
      level: "warn",
    },
    {
      stream: pino.destination(1),
    },
  ])
);

export const commonLogger = pino.pino(
  {
    timestamp: () => {
      return `,"time":"${new Date().toISOString()}"`;
    },
    formatters: {
      bindings: (bindings: pino.Bindings) => {
        bindings;
        return {};
      },
    },
  },
  pino.multistream([
    {
      stream: PORT_ENV.HEARTBEAT_WEBHOOK_URL
        ? new logSlack(PORT_ENV.HEARTBEAT_WEBHOOK_URL)
        : pino.destination(2),
      level: "warn",
    },
    {
      stream: pino.destination(1),
    },
  ])
);

export const log = {
  alert: alertLogger,
  trace: traceLogger,
  common: commonLogger,
};
