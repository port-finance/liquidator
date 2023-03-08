import { Message, Blocks, Md } from "slack-block-builder";
import * as winston from "winston";
import WinstonTransport from "winston-transport";

interface TransformableInfo {
  level: string;
  message: any;
  [key: string | symbol]: any;
}

class SlackTransport extends WinstonTransport {
  constructor(
    private webhook: string,
    opt?: winston.transport.TransportStreamOptions
  ) {
    super(opt);
  }

  public log(info: TransformableInfo, next: () => void) {
    const { level, message, timestamp, ...meta } = info;
    const ownMeta = Object.fromEntries(
      Object.keys(meta).map((key) => [key, meta[key]])
    );

    const slackMsgBuilder = Message().blocks(
      Blocks.Section({
        text: `[${timestamp} ${level.toUpperCase()}] ${message}`,
      })
    );
    if (Object.keys(ownMeta).length > 0) {
      slackMsgBuilder.blocks(
        Blocks.Section({
          text: Md.codeBlock(JSON.stringify(ownMeta, undefined, 2)),
        })
      );
    }
    const slackMsg = slackMsgBuilder.buildToJSON();

    fetch(this.webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: slackMsg,
    })
      .catch((e) => {
        console.error(`Err pushing to remote logging service: ${e}`);
      })
      .finally(() => {
        next();
      });
  }
}

export const createLogger = (
  slack?: { webhook?: string; level: string },
  opt?: { meta: object }
) => {
  const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.splat()
    ),
    defaultMeta: opt?.meta,
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
      }),
    ],
  });

  if (slack?.webhook) {
    logger.add(new SlackTransport(slack.webhook, { level: slack.level }));
  }
  return logger;
};
