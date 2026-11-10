import type { ChannelPlatform } from "@/app/generated/prisma/client";
import { recordUsage } from "@/lib/usage/meter";
import type { ChannelAdapter, ChannelMessaging } from "./adapter";
import type { OutboundContent, SendReceipt, SendTarget } from "./content";

/**
 * Every send through one account, observed in one place.
 *
 * The worker, the inbox, onboarding's test message and the API all send
 * through the adapter that openChannel hands them. Wrapping that adapter's
 * send here is what lets usage be metered, and sent and failed messages be
 * reported, for every path at once, including any added later. The wrapper
 * only observes: what the platform answered is returned or thrown unchanged.
 */

/** Who asked for the message, so a report can tell automation from a person. */
export type SendSource = "automation" | "inbox" | "api";

export interface SendObservation {
  workspaceId: string;
  accountId: string;
  platform: ChannelPlatform;
  source: SendSource;
  to: SendTarget;
  content: OutboundContent;
}

export interface ChannelObserver {
  sent(observation: SendObservation, receipt: SendReceipt): Promise<void>;
  failed(observation: SendObservation, error: unknown): Promise<void>;
  publicReplied(observation: Omit<SendObservation, "to" | "content"> & { commentId: string }): Promise<void>;
}

/** Usage only. Event delivery adds itself through registerChannelObserver. */
const meterObserver: ChannelObserver = {
  async sent(observation) {
    await recordUsage({
      workspaceId: observation.workspaceId,
      platform: observation.platform,
      kind: "MESSAGE_SENT",
    });
  },
  async failed() {
    // A failed send costs nothing and is not counted.
  },
  async publicReplied(observation) {
    await recordUsage({
      workspaceId: observation.workspaceId,
      platform: observation.platform,
      kind: "PUBLIC_REPLY",
    });
  },
};

const observers: ChannelObserver[] = [meterObserver];

export function registerChannelObserver(observer: ChannelObserver): void {
  if (!observers.includes(observer)) observers.push(observer);
}

/** Observers never break a send: each one's failure is logged and passed over. */
async function notify(run: (observer: ChannelObserver) => Promise<void>): Promise<void> {
  for (const observer of observers) {
    try {
      await run(observer);
    } catch (error) {
      console.error(
        "[channel] A send observer failed:",
        error instanceof Error ? `${error.name}: ${error.message}` : "unknown"
      );
    }
  }
}

export function instrumentAdapter(
  adapter: ChannelAdapter,
  scope: { workspaceId: string; accountId: string; source: SendSource }
): ChannelAdapter {
  const base = {
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    platform: adapter.platform as ChannelPlatform,
    source: scope.source,
  };

  const messaging: ChannelMessaging = {
    ...adapter.messaging,
    async send(context, input) {
      const observation: SendObservation = { ...base, to: input.to, content: input.content };
      let receipt: SendReceipt;
      try {
        receipt = await adapter.messaging.send(context, input);
      } catch (error) {
        await notify((observer) => observer.failed(observation, error));
        throw error;
      }
      await notify((observer) => observer.sent(observation, receipt));
      return receipt;
    },
    async publicReply(context, input) {
      const result = await adapter.messaging.publicReply(context, input);
      await notify((observer) => observer.publicReplied({ ...base, commentId: input.commentId }));
      return result;
    },
  };

  return { ...adapter, messaging };
}
