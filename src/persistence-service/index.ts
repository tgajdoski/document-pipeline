import { RedisClient } from '../lib/redis';
import { Document, DocumentStatus } from '../types/document';
import dotenv from 'dotenv';

dotenv.config();

const STREAM_KEY = 'validation_queue';
const GROUP_NAME = 'persistence_processor_group';
const CONSUMER_NAME = `persistence_worker_${process.env.NODE_ENV || '1'}_${process.pid}`;

/**
 * Handles the final persistence of a document.
 *
 * @param documentId The ID of the document to persist.
 * This function:
 * 1. Fetches the document from Redis.
 * 2. If the document status is 'VALIDATED', it updates its status to 'PERSISTED' in Redis.
 * In a real system, this would involve moving data to a long-term database (e.g., PostgreSQL, MongoDB)
 * and/or dedicated cloud storage (S3, Azure Blob Storage).
 * 3. Cleans up the original document content from temporary Redis storage to save memory.
 * 4. Handles documents with 'VALIDATION_FAILED' status by simply logging them and marking as 'FAILED'.
 * 5. Handles errors by updating status to 'FAILED' and publishing to a dead-letter queue.
 */
async function persistDocument(documentId: string): Promise<void> {
  let document: Document | null = null;
  try {
    // 1. Fetch document metadata from Redis Hash
    const docHash = await RedisClient.hgetall(`document:${documentId}`);
    if (!docHash || Object.keys(docHash).length === 0) {
      console.error(`[Persistence Service] Document not found for persistence: ${documentId}`);
      return;
    }

    // Reconstruct document object from Redis hash
    document = {
        id: docHash.id,
        filename: docHash.filename,
        status: docHash.status as DocumentStatus,
        createdAt: docHash.createdAt,
        updatedAt: docHash.updatedAt,
        originalContent: Buffer.from(''), // Not directly needed here, but for type consistency
        ocrResult: docHash.ocrResult ? JSON.parse(docHash.ocrResult) : undefined,
        extractedMetadata: docHash.extractedMetadata ? JSON.parse(docHash.extractedMetadata) : undefined,
        validationErrors: docHash.validationErrors ? JSON.parse(docHash.validationErrors) : undefined,
    };

    // 2. Check the document's status for final persistence decision
    if (document.status === 'VALIDATED') {
      // In a real production application, this is where you would:
      // a) Insert the `extractedMetadata` and a reference to the `originalContent`
      //    (if stored in blob storage) into your primary database (e.g., PostgreSQL, MongoDB).
      // b) Potentially move the original file from temporary storage to long-term archive storage.

      // For this prototype, we're simulating final persistence by
      // updating the document's status in Redis to 'PERSISTED'.
      await RedisClient.hset(
        `document:${documentId}`,
        'status', 'PERSISTED',
        'updatedAt', new Date().toISOString()
      );
      console.log(`[Persistence Service] Document ${documentId} successfully persisted. Final status: PERSISTED.`);

      // 3. Clean up original content from temporary Redis storage to save memory
      await RedisClient.del(`document_content:${documentId}`);
      console.log(`[Persistence Service] Original content for document ${documentId} removed from temporary storage.`);

    } else if (document.status === 'VALIDATION_FAILED') {
      // Document did not pass validation, so it's not "persisted" in the successful sense.
      // Its status should already be VALIDATION_FAILED from the previous step.
      // We can optionally mark it as a general 'FAILED' if it needs a distinct final state.
      await RedisClient.hset(
        `document:${documentId}`,
        'status', 'FAILED',
        'updatedAt', new Date().toISOString()
      );
      console.log(`[Persistence Service] Document ${documentId} not persisted due to validation failure. Final status: FAILED.`);
    } else {
        console.warn(`[Persistence Service] Document ${documentId} received for persistence with unexpected status: ${document.status}. No specific action taken.`);
    }

  } catch (error) {
    console.error(`[Persistence Service] Error during persistence for document ${documentId}:`, error);
    // 5. Handle errors: update status to 'FAILED' and send to DLQ
    if (document) {
      await RedisClient.hset(
        `document:${documentId}`,
        'status', 'FAILED',
        'updatedAt', new Date().toISOString()
      );
      // Publish to a dead-letter queue for persistence failures
      await RedisClient.xadd(
        'dlq_persistence_failed',
        '*',
        'documentId', documentId,
        'error', (error instanceof Error ? error.message : 'Unknown error')
      );
      console.log(`[Persistence Service] Document ${documentId} marked as FAILED and sent to DLQ.`);
    }
  }
}

/**
 * Starts the Persistence processor consumer, listening to the 'validation_queue' Redis Stream.
 */
export async function startPersistenceProcessor(): Promise<void> {
  // Ensure the consumer group exists or create it
  try {
    await RedisClient.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '$', 'MKSTREAM');
    console.log(`[Persistence Service] Consumer group '${GROUP_NAME}' created for stream '${STREAM_KEY}'.`);
  } catch (err: any) {
    if (err.message.includes('BUSYGROUP')) {
      console.log(`[Persistence Service] Consumer group '${GROUP_NAME}' already exists.`);
    } else {
      console.error(`[Persistence Service] Error creating consumer group:`, err);
      process.exit(1);
    }
  }

  console.log(`[Persistence Service] ${CONSUMER_NAME} started, listening to '${STREAM_KEY}'...`);

  // Start the message consumption loop
  while (true) {
    try {
      const messages = await RedisClient.xreadgroup(
        'GROUP', GROUP_NAME, CONSUMER_NAME,
        'COUNT', 1,
        'BLOCK', 0,
        'STREAMS', STREAM_KEY, '>'
      );

      if (messages && messages.length > 0) {
        for (const stream of messages as [string, [string, string[]][]][]) {
          const messageArray = stream[1]; 
          for (const message of messageArray) {
            const messageId = message[0];
            const data = message[1];
            const documentIdIndex = data.indexOf('documentId');
            const documentId = documentIdIndex !== -1 ? data[documentIdIndex + 1] : null;

            if (documentId) {
              console.log(`[Persistence Service] Received message ID: ${messageId} for document: ${documentId}`);
              await persistDocument(documentId);
              await RedisClient.xack(STREAM_KEY, GROUP_NAME, messageId);
              console.log(`[Persistence Service] Message ID ${messageId} acknowledged for document ${documentId}.`);
            } else {
              console.warn(`[Persistence Service] Received message without documentId: ${JSON.stringify(data)}. Acknowledging to avoid reprocessing.`);
              await RedisClient.xack(STREAM_KEY, GROUP_NAME, messageId);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[Persistence Service] Error in main processing loop:`, error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Start the processor when the script runs
startPersistenceProcessor();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[Persistence Service] Shutting down...');
  process.exit(0);
});