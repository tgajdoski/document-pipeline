import { RedisClient } from '../lib/redis';
import { Document, DocumentStatus, InvoiceMetadata } from '../types/document';
import dotenv from 'dotenv';

dotenv.config();

const STREAM_KEY = 'ocr_result_queue';
const GROUP_NAME = 'validation_processor_group';
const CONSUMER_NAME = `validation_worker_${process.env.NODE_ENV || '1'}_${process.pid}`;

/**
 * Extracts invoice-specific metadata from the OCR text.
 * This is a simplified extraction using regular expressions for the prototype.
 * In a real application, more sophisticated parsing or ML models would be used.
 *
 * @param ocrText The full text output from the OCR process.
 * @returns A partial InvoiceMetadata object with extracted fields.
 */
function extractInvoiceMetadata(ocrText: string): Partial<InvoiceMetadata> {
  const metadata: Partial<InvoiceMetadata> = {};

  // Regex to find "Invoice Number: <value>"
  const invoiceNumberMatch = ocrText.match(/Invoice Number:\s*(\S+)/i);
  if (invoiceNumberMatch) metadata.invoiceNumber = invoiceNumberMatch[1].trim();

  // Regex to find "Customer: <value>"
  const customerNameMatch = ocrText.match(/Customer:\s*(.+)/i);
  if (customerNameMatch) metadata.customerName = customerNameMatch[1].trim();

  // Regex to find "Total: <amount> <currency>" or "Total Amount: <amount>"
  const totalAmountMatch = ocrText.match(/Total(?:\s+Amount)?:\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)\s*([A-Z]{3})?/i);
  if (totalAmountMatch) {
    // Clean amount (remove commas, replace decimal comma with dot if needed)
    const amountStr = totalAmountMatch[1].replace(/,/g, '');
    metadata.totalAmount = parseFloat(amountStr);
    // If currency is in the same line, use it; otherwise look for separate Currency line
    if (totalAmountMatch[2]) {
      metadata.currency = totalAmountMatch[2].toUpperCase();
    }
  }

  // If currency wasn't found in the total line, look for separate "Currency: <value>" line
  if (!metadata.currency) {
    const currencyMatch = ocrText.match(/Currency:\s*([A-Z]{3})/i);
    if (currencyMatch) metadata.currency = currencyMatch[1].toUpperCase();
  }

  // Regex to find "Date: YYYY-MM-DD"
  const issueDateMatch = ocrText.match(/Date:\s*(\d{4}-\d{2}-\d{2})/);
  if (issueDateMatch) metadata.issueDate = issueDateMatch[1];

  return metadata;
}

/**
 * Validates the extracted invoice metadata to ensure all required fields are present.
 *
 * @param metadata The partial InvoiceMetadata object.
 * @returns An array of error messages if validation fails, empty array if successful.
 */
function validateInvoiceMetadata(metadata: Partial<InvoiceMetadata>): string[] {
  const errors: string[] = [];
  if (!metadata.invoiceNumber || metadata.invoiceNumber.length === 0) errors.push('Invoice Number is missing or empty.');
  if (!metadata.customerName || metadata.customerName.length === 0) errors.push('Customer Name is missing or empty.');
  if (metadata.totalAmount === undefined || isNaN(metadata.totalAmount) || metadata.totalAmount <= 0) errors.push('Total Amount is missing, invalid, or zero/negative.');
  if (!metadata.currency || metadata.currency.length === 0) errors.push('Currency is missing or empty.');
  if (!metadata.issueDate || !/^\d{4}-\d{2}-\d{2}$/.test(metadata.issueDate)) errors.push('Issue Date is missing or invalid (expected YYYY-MM-DD).');
  return errors;
}

/**
 * Processes a document for metadata extraction and validation.
 *
 * @param documentId The ID of the document to process.
 * This function:
 * 1. Fetches the document from Redis.
 * 2. Updates document status to VALIDATION_PENDING.
 * 3. Extracts and validates invoice metadata from the OCR text.
 * 4. Updates the document in Redis with extracted metadata, validation errors (if any), and status.
 * 5. Publishes a message to the 'validation_queue' for the persistence stage.
 * 6. Handles errors by updating status to 'VALIDATION_FAILED' and publishing to a dead-letter queue.
 */
async function processDocumentForValidation(documentId: string): Promise<void> {
  let document: Document | null = null;
  try {
    // Fetch document metadata from Redis Hash
    const docHash = await RedisClient.hgetall(`document:${documentId}`);
    if (!docHash || Object.keys(docHash).length === 0) {
      console.error(`[Validation Service] Document not found for validation: ${documentId}`);
      return;
    }

    // Reconstruct document object. Note: originalContent is not needed here.
    document = {
        id: docHash.id,
        filename: docHash.filename,
        status: docHash.status as DocumentStatus,
        createdAt: docHash.createdAt,
        updatedAt: docHash.updatedAt,
        originalContent: Buffer.from(''), // Placeholder
        ocrResult: docHash.ocrResult ? JSON.parse(docHash.ocrResult) : undefined,
    };

    // Ensure OCR result is present before attempting extraction
    if (!document.ocrResult || !document.ocrResult.text) {
      throw new Error(`OCR result missing for document ${documentId}. Cannot validate.`);
    }

    // Update document status to 'VALIDATION_PENDING'
    await RedisClient.hset(
      `document:${documentId}`,
      'status', 'VALIDATION_PENDING',
      'updatedAt', new Date().toISOString()
    );
    console.log(`[Validation Service] Document ${documentId} status updated to VALIDATION_PENDING.`);

    // Extract and validate metadata
    console.log(`[Validation Service] Extracting metadata for document ${documentId}... `, document.ocrResult.text);
    const extractedMetadata = extractInvoiceMetadata(document.ocrResult.text);
    const validationErrors = validateInvoiceMetadata(extractedMetadata);

    if (validationErrors.length > 0) {
      // Validation failed
      document.status = 'VALIDATION_FAILED';
      document.validationErrors = validationErrors;
      document.extractedMetadata = extractedMetadata as InvoiceMetadata; // Still store what was extracted

      await RedisClient.hset(
        `document:${documentId}`,
        'extractedMetadata', JSON.stringify(extractedMetadata),
        'validationErrors', JSON.stringify(validationErrors),
        'status', 'VALIDATION_FAILED',
        'updatedAt', new Date().toISOString()
      );
      console.warn(`[Validation Service] Validation failed for document ${documentId}:`, validationErrors);

      // Publish to next queue, indicating failure
      await RedisClient.xadd(
        'validation_queue',
        '*',
        'documentId', documentId,
        'status', 'VALIDATION_FAILED'
      );
      console.log(`[Validation Service] Document ${documentId} (VALIDATION_FAILED) queued for persistence.`);
    } else {
      // Validation succeeded
      document.status = 'VALIDATED';
      document.extractedMetadata = extractedMetadata as InvoiceMetadata; // Cast as it's now complete

      await RedisClient.hset(
        `document:${documentId}`,
        'extractedMetadata', JSON.stringify(extractedMetadata),
        'status', 'VALIDATED',
        'updatedAt', new Date().toISOString()
      );
      console.log(`[Validation Service] Validation succeeded for document ${documentId}. Extracted:`, extractedMetadata);

      // Publish to next queue, indicating success
      await RedisClient.xadd(
        'validation_queue',
        '*',
        'documentId', documentId,
        'status', 'VALIDATED'
      );
      console.log(`[Validation Service] Document ${documentId} (VALIDATED) queued for persistence.`);
    }

  } catch (error) {
    console.error(`[Validation Service] Error during validation for document ${documentId}:`, error);
    // Handle errors: update status to 'VALIDATION_FAILED' and send to DLQ
    if (document) {
      await RedisClient.hset(
        `document:${documentId}`,
        'status', 'VALIDATION_FAILED',
        'updatedAt', new Date().toISOString()
      );
      // Publish to a dead-letter queue
      await RedisClient.xadd(
        'dlq_validation_failed',
        '*',
        'documentId', documentId,
        'error', (error instanceof Error ? error.message : 'Unknown error')
      );
      console.log(`[Validation Service] Document ${documentId} marked as VALIDATION_FAILED and sent to DLQ.`);
    }
  }
}

/**
 * Starts the Validation processor consumer, listening to the 'ocr_result_queue' Redis Stream.
 */
export async function startValidationProcessor(): Promise<void> {
  // Ensure the consumer group exists or create it
  try {
    await RedisClient.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '$', 'MKSTREAM');
    console.log(`[Validation Service] Consumer group '${GROUP_NAME}' created for stream '${STREAM_KEY}'.`);
  } catch (err: any) {
    if (err.message.includes('BUSYGROUP')) {
      console.log(`[Validation Service] Consumer group '${GROUP_NAME}' already exists.`);
    } else {
      console.error(`[Validation Service] Error creating consumer group:`, err);
      process.exit(1);
    }
  }

  console.log(`[Validation Service] ${CONSUMER_NAME} started, listening to '${STREAM_KEY}'...`);

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
              console.log(`[Validation Service] Received message ID: ${messageId} for document: ${documentId}`);
              await processDocumentForValidation(documentId);
              await RedisClient.xack(STREAM_KEY, GROUP_NAME, messageId);
              console.log(`[Validation Service] Message ID ${messageId} acknowledged for document ${documentId}.`);
            } else {
              console.warn(`[Validation Service] Received message without documentId: ${JSON.stringify(data)}. Acknowledging to avoid reprocessing.`);
              await RedisClient.xack(STREAM_KEY, GROUP_NAME, messageId);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[Validation Service] Error in main processing loop:`, error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Start the processor
startValidationProcessor();

process.on('SIGINT', async () => {
  console.log('[Validation Service] Shutting down...');
  process.exit(0);
});