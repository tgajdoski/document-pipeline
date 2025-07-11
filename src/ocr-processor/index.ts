import { RedisClient } from '../lib/redis';
import { simulateOCR } from '../lib/ocr';
import { Document, DocumentStatus, OCRResult } from '../types/document';
import dotenv from 'dotenv';

dotenv.config();

const STREAM_KEY = 'document_queue';
const GROUP_NAME = 'ocr_processor_group';
const CONSUMER_NAME = `ocr_worker_${process.env.NODE_ENV || '1'}_${process.pid}`; // Unique consumer name per process

/**
 * Processes a document by simulating OCR.
 *
 * @param documentId The ID of the document to process.
 * This function:
 * 1. Fetches the document and its content from Redis.
 * 2. Updates the document status to OCR_PENDING.
 * 3. Calls the `simulateOCR` function.
 * 4. Updates the document in Redis with the OCR result and 'OCR_COMPLETED' status.
 * 5. Publishes a message to the 'ocr_result_queue' for the next stage.
 * 6. Handles errors by updating status to 'OCR_FAILED' and publishing to a dead-letter queue.
 */
async function processDocumentForOCR(documentId: string): Promise<void> {
  let document: Document | null = null;
  let originalContent: Buffer | null = null;

  try {
    // Fetch document metadata from Redis Hash
    const docHash = await RedisClient.hgetall(`document:${documentId}`);
    if (!docHash || Object.keys(docHash).length === 0) {
      console.error(`[OCR Processor] Document not found: ${documentId}`);
      return;
    }

    // Reconstruct basic document object. originalContent will be fetched separately.
    document = {
      id: docHash.id,
      filename: docHash.filename,
      status: docHash.status as DocumentStatus,
      createdAt: docHash.createdAt,
      updatedAt: docHash.updatedAt,
      originalContent: Buffer.from(''), // Placeholder for initial type safety
    };

    // Fetch original content, which is stored as a Redis String/Binary
    originalContent = await RedisClient.getBuffer(`document_content:${documentId}`);
    if (!originalContent) {
      throw new Error(`Original content not found for document: ${documentId}`);
    }
    document.originalContent = originalContent; // Assign actual content to the document object

    // Update document status to 'OCR_PENDING'
    await RedisClient.hset(
      `document:${documentId}`,
      'status', 'OCR_PENDING',
      'updatedAt', new Date().toISOString()
    );
    console.log(`[OCR Processor] Document ${documentId} status updated to OCR_PENDING.`);

    // Simulate OCR processing
    const ocrResult: OCRResult = await simulateOCR(document.originalContent);
    document.ocrResult = ocrResult;

    // Update document in Redis with OCR result and 'OCR_COMPLETED' status
    await RedisClient.hset(
      `document:${documentId}`,
      'ocrResult', JSON.stringify(ocrResult),
      'status', 'OCR_COMPLETED',
      'updatedAt', new Date().toISOString()
    );
    console.log(`[OCR Processor] OCR completed for document: ${documentId}. Status updated to OCR_COMPLETED.`);

    // Publish to the next queue ('ocr_result_queue') for validation
    await RedisClient.xadd(
      'ocr_result_queue',
      '*',
      'documentId', documentId,
      'status', 'OCR_COMPLETED'
    );
    console.log(`[OCR Processor] Document ${documentId} queued for validation.`);

  } catch (error) {
    console.error(`[OCR Processor] Error during OCR for document ${documentId}:`, error);
    // 6. Handle errors: update status to 'OCR_FAILED' and send to DLQ
    if (document) {
      await RedisClient.hset(
        `document:${documentId}`,
        'status', 'OCR_FAILED',
        'updatedAt', new Date().toISOString()
      );
      // Publish to a dead-letter queue for failed OCR processing
      await RedisClient.xadd(
        'dlq_ocr_failed',
        '*',
        'documentId', documentId,
        'error', (error instanceof Error ? error.message : 'Unknown error')
      );
      console.log(`[OCR Processor] Document ${documentId} marked as OCR_FAILED and sent to DLQ.`);
    }
  }
}

/**
 * Starts the OCR processor consumer, listening to the 'document_queue' Redis Stream.
 * It uses a consumer group to allow multiple instances to process messages.
 */
export async function startOcrProcessor(): Promise<void> {
  // Ensure the consumer group exists or create it
  try {
    await RedisClient.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '$', 'MKSTREAM');
    console.log(`[OCR Processor] Consumer group '${GROUP_NAME}' created for stream '${STREAM_KEY}'.`);
  } catch (err: any) {
    if (err.message.includes('BUSYGROUP')) {
      console.log(`[OCR Processor] Consumer group '${GROUP_NAME}' already exists.`);
    } else {
      console.error(`[OCR Processor] Error creating consumer group:`, err);
      process.exit(1); // Exit if unable to create group
    }
  }

  console.log(`[OCR Processor] ${CONSUMER_NAME} started, listening to '${STREAM_KEY}'...`);

  // Start the message consumption loop
  while (true) {
    try {
      // XREADGROUP reads messages from the stream for a specific consumer group
      const messages = await RedisClient.xreadgroup(
        'GROUP', GROUP_NAME, CONSUMER_NAME, // Consumer group name and consumer name
        'COUNT', 1,                          // Read one message at a time
        'BLOCK', 0,                          // Block indefinitely until a message is available
        'STREAMS', STREAM_KEY, '>'           // Read from STREAM_KEY, starting from the next unread message (>)
      );

      if (messages && messages.length > 0) {
        // structure is [streamName, [messageId, [field1, value1, field2, value2]]]
        for (const stream of messages as [string, [string, string[]][]][]) {
          const messageArray = stream[1]; // Get the array of messages for this stream
          for (const message of messageArray) {
            const messageId = message[0];
            const data = message[1];      // The message data as an array [key1, val1, key2, val2, ...]

            console.log(`[OCR Processor] Received message ID: ${messageId} with data: ${JSON.stringify(data)}`);
            // Extract documentId from the message data
            const documentIdIndex = data.indexOf('documentId');
            const documentId = documentIdIndex !== -1 ? data[documentIdIndex + 1] : null;

            if (documentId) {
              console.log(`[OCR Processor] Received message ID: ${messageId} for document: ${documentId}`);
              await processDocumentForOCR(documentId);
              // Acknowledge the message after successful processing
              await RedisClient.xack(STREAM_KEY, GROUP_NAME, messageId);
              console.log(`[OCR Processor] Message ID ${messageId} acknowledged for document ${documentId}.`);
            } else {
              console.warn(`[OCR Processor] Received message without documentId: ${JSON.stringify(data)}. Acknowledging to avoid reprocessing.`);
              await RedisClient.xack(STREAM_KEY, GROUP_NAME, messageId); // Acknowledge bad message
            }
          }
        }
      }
    } catch (error) {
      console.error(`[OCR Processor] Error in main processing loop:`, error);
      // Wait before retrying to prevent a tight loop on persistent errors
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}


startOcrProcessor();


process.on('SIGINT', async () => {
  console.log('[OCR Processor] Shutting down...');
  // The Redis client has its own SIGINT handler in lib/redis.ts
  process.exit(0);
});