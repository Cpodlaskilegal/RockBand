import { QueueClient } from "@azure/storage-queue";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { CancelJob, DispatchJob, QueueJob, RefreshJob, WorkerEventJob } from "@rockband/shared";

export interface QueueHandlers {
  dispatch(job: DispatchJob): Promise<void>;
  refresh(job: RefreshJob): Promise<void>;
  cancel(job: CancelJob): Promise<void>;
  workerEvent(job: WorkerEventJob): Promise<void>;
}

export interface JobQueue {
  publishDispatch(job: DispatchJob, delayMs?: number): Promise<void>;
  publishRefresh(job: RefreshJob, delayMs?: number): Promise<void>;
  publishCancel(job: CancelJob, delayMs?: number): Promise<void>;
  publishWorkerEvent(job: WorkerEventJob, delayMs?: number): Promise<void>;
  startConsumers?(handlers: QueueHandlers): Promise<void>;
}

export class InMemoryJobQueue implements JobQueue {
  private handlers?: QueueHandlers;

  async publishDispatch(job: DispatchJob, delayMs = 0): Promise<void> {
    await this.defer(delayMs, async () => {
      await this.handlers?.dispatch(job);
    });
  }

  async publishRefresh(job: RefreshJob, delayMs = 0): Promise<void> {
    await this.defer(delayMs, async () => {
      await this.handlers?.refresh(job);
    });
  }

  async publishCancel(job: CancelJob, delayMs = 0): Promise<void> {
    await this.defer(delayMs, async () => {
      await this.handlers?.cancel(job);
    });
  }

  async publishWorkerEvent(job: WorkerEventJob, delayMs = 0): Promise<void> {
    await this.defer(delayMs, async () => {
      await this.handlers?.workerEvent(job);
    });
  }

  async startConsumers(handlers: QueueHandlers): Promise<void> {
    this.handlers = handlers;
  }

  private async defer(delayMs: number, callback: (() => Promise<void>) | undefined): Promise<void> {
    if (!callback) {
      return;
    }

    if (delayMs <= 0) {
      await callback();
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        void callback().finally(resolve);
      }, delayMs);
    });
  }
}

export interface SqsQueueUrls {
  dispatch: string;
  refresh: string;
  cancel: string;
  workerEvent: string;
}

export class SqsJobQueue implements JobQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly urls: SqsQueueUrls,
  ) {}

  async publishDispatch(job: DispatchJob, delayMs = 0): Promise<void> {
    await this.publish(this.urls.dispatch, job, delayMs);
  }

  async publishRefresh(job: RefreshJob, delayMs = 0): Promise<void> {
    await this.publish(this.urls.refresh, job, delayMs);
  }

  async publishCancel(job: CancelJob, delayMs = 0): Promise<void> {
    await this.publish(this.urls.cancel, job, delayMs);
  }

  async publishWorkerEvent(job: WorkerEventJob, delayMs = 0): Promise<void> {
    await this.publish(this.urls.workerEvent, job, delayMs);
  }

  async startConsumers(handlers: QueueHandlers): Promise<void> {
    void this.poll(this.urls.dispatch, handlers.dispatch);
    void this.poll(this.urls.refresh, handlers.refresh);
    void this.poll(this.urls.cancel, handlers.cancel);
    void this.poll(this.urls.workerEvent, handlers.workerEvent);
  }

  private async publish(queueUrl: string, job: QueueJob, delayMs: number): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(job),
        DelaySeconds: Math.min(Math.max(Math.ceil(delayMs / 1000), 0), 900),
      }),
    );
  }

  private async poll<T extends QueueJob>(queueUrl: string, handler: (job: T) => Promise<void>): Promise<void> {
    for (;;) {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 20,
        }),
      );

      for (const message of response.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) {
          continue;
        }

        const job = JSON.parse(message.Body) as T;
        await handler(job);
        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }
  }
}

export interface AzureQueueNames {
  dispatch: string;
  refresh: string;
  cancel: string;
  workerEvent: string;
}

export class AzureQueueJobQueue implements JobQueue {
  private readonly clients: Record<keyof AzureQueueNames, QueueClient>;

  constructor(
    connectionString: string,
    queueNames: AzureQueueNames,
  ) {
    this.clients = {
      dispatch: new QueueClient(connectionString, queueNames.dispatch),
      refresh: new QueueClient(connectionString, queueNames.refresh),
      cancel: new QueueClient(connectionString, queueNames.cancel),
      workerEvent: new QueueClient(connectionString, queueNames.workerEvent),
    };
  }

  async publishDispatch(job: DispatchJob, delayMs = 0): Promise<void> {
    await this.publish(this.clients.dispatch, job, delayMs);
  }

  async publishRefresh(job: RefreshJob, delayMs = 0): Promise<void> {
    await this.publish(this.clients.refresh, job, delayMs);
  }

  async publishCancel(job: CancelJob, delayMs = 0): Promise<void> {
    await this.publish(this.clients.cancel, job, delayMs);
  }

  async publishWorkerEvent(job: WorkerEventJob, delayMs = 0): Promise<void> {
    await this.publish(this.clients.workerEvent, job, delayMs);
  }

  async startConsumers(handlers: QueueHandlers): Promise<void> {
    await Promise.all(Object.values(this.clients).map((client) => client.createIfNotExists()));
    void this.poll(this.clients.dispatch, handlers.dispatch);
    void this.poll(this.clients.refresh, handlers.refresh);
    void this.poll(this.clients.cancel, handlers.cancel);
    void this.poll(this.clients.workerEvent, handlers.workerEvent);
  }

  private async publish(queue: QueueClient, job: QueueJob, delayMs: number): Promise<void> {
    await queue.createIfNotExists();
    await queue.sendMessage(encodeAzureQueueMessage(job), {
      visibilityTimeout: Math.min(Math.max(Math.ceil(delayMs / 1000), 0), 7 * 24 * 60 * 60),
    });
  }

  private async poll<T extends QueueJob>(queue: QueueClient, handler: (job: T) => Promise<void>): Promise<void> {
    for (;;) {
      const response = await queue.receiveMessages({
        numberOfMessages: 5,
        visibilityTimeout: 60,
      });

      for (const message of response.receivedMessageItems) {
        if (!message.messageText || !message.messageId || !message.popReceipt) {
          continue;
        }

        const job = decodeAzureQueueMessage<T>(message.messageText);
        await handler(job);
        await queue.deleteMessage(message.messageId, message.popReceipt);
      }
    }
  }
}

export function encodeAzureQueueMessage(job: QueueJob): string {
  return Buffer.from(JSON.stringify(job), "utf8").toString("base64");
}

export function decodeAzureQueueMessage<T extends QueueJob>(messageText: string): T {
  return JSON.parse(Buffer.from(messageText, "base64").toString("utf8")) as T;
}
