import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { RedisClient } from '../lib/redis';
import { Document, DocumentStatus } from '../types/document';
import dotenv from 'dotenv';

dotenv.config(); // Load environment variables

const app = express();
const upload = multer(); // in-memory storage of files
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors({
  origin: ['http://localhost:3001', 'http://localhost:3000', 'http://localhost:5000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

/**
 * Handles document uploads via an HTTP POST request.
 *
 * @route POST /upload
 * @middleware upload.single('document') - Expects a single file field named 'document'.
 *
 * This service:
 * 1. Receives the uploaded file.
 * 2. Generates a unique ID for the document.
 * 3. Initializes the document's status to 'UPLOADED'.
 * 4. Stores the document's metadata (using Redis Hash) and original content (using Redis String/Binary) in Redis.
 * 5. Publishes a message to the 'document_queue' Redis Stream to trigger the next processing stage.
 * 6. Responds to the client with the document ID and a success message.
 */
app.post('/upload', upload.single('document'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No document uploaded. Please ensure the file field is named "document".' });
  }

  const documentId = uuidv4(); 
  const filename = req.file.originalname;
  const originalContent = req.file.buffer; 

  const document: Document = {
    id: documentId,
    filename: filename,
    originalContent: originalContent,
    status: "UPLOADED",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    // Store document metadata in a Redis Hash using HSET
    await RedisClient.hset(
      `document:${documentId}`,
      'id', document.id,
      'filename', document.filename,
      'status', document.status,
      'createdAt', document.createdAt,
      'updatedAt', document.updatedAt
      // originalContent, ocrResult, extractedMetadata are stored separately or added later
    );

    // Store the original binary content // better to use cloud storage (S3, Azure Blob Storage) and store only the URL here.
    await RedisClient.set(`document_content:${documentId}`, originalContent);

    // Publish a message to the 'document_queue' Redis Stream and it triggers the OCR processing stage.
    await RedisClient.xadd(
      'document_queue', // Stream key
      '*',
      'documentId', documentId,
      'status', 'UPLOADED'
    );

    console.log(`[Upload Service] Document ${documentId} uploaded and queued.`);
    res.status(202).json({
      message: 'Document uploaded and queued for processing',
      documentId: documentId,
      filename: filename,
      status: document.status
    });
  } catch (error) {
    console.error(`[Upload Service] Error uploading document ${filename}:`, error);
    res.status(500).json({ error: 'Internal Server Error during document upload.' });
  }
});

/**
 * Handles document status retrieval via an HTTP GET request.
 *
 * @route GET /document/:id
 * @param id - The document ID to retrieve
 *
 * This endpoint:
 * 1. Fetches the document metadata from Redis.
 * 2. Returns the document information excluding the original content.
 */
app.get('/document/:id', async (req, res) => {
  const documentId = req.params.id;

  if (!documentId) {
    return res.status(400).json({ error: 'Document ID is required.' });
  }

  try {
    // Fetch document metadata from Redis Hash
    const docHash = await RedisClient.hgetall(`document:${documentId}`);
    if (!docHash || Object.keys(docHash).length === 0) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    // Reconstruct document object from Redis hash (excluding originalContent)
    const document = {
      id: docHash.id,
      filename: docHash.filename,
      status: docHash.status as DocumentStatus,
      createdAt: docHash.createdAt,
      updatedAt: docHash.updatedAt,
      ocrResult: docHash.ocrResult ? JSON.parse(docHash.ocrResult) : undefined,
      extractedMetadata: docHash.extractedMetadata ? JSON.parse(docHash.extractedMetadata) : undefined,
      validationErrors: docHash.validationErrors ? JSON.parse(docHash.validationErrors) : undefined,
    };

    res.status(200).json(document);
  } catch (error) {
    console.error(`[Upload Service] Error fetching document ${documentId}:`, error);
    res.status(500).json({ error: 'Internal Server Error while fetching document.' });
  }
});

app.listen(PORT, () => {
  console.log(`[Upload Service] Listening on http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('[Upload Service] Shutting down...');
  process.exit(0);
});