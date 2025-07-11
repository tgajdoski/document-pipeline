/**
 * Defines the possible processing statuses for a document within the pipeline.
 */
export type DocumentStatus =
  | "UPLOADED"
  | "OCR_PENDING"
  | "OCR_COMPLETED"
  | "OCR_FAILED"
  | "VALIDATION_PENDING"
  | "VALIDATED"
  | "VALIDATION_FAILED"
  | "PERSISTENCE_PENDING"
  | "PERSISTED"
  | "FAILED"; // General failure state

/**
 * Defines the structured metadata expected to be extracted from an invoice.
 * This can be extended based on the specific document type.
 */
export interface InvoiceMetadata {
  invoiceNumber: string;
  customerName: string;
  totalAmount: number;
  currency: string;
  issueDate: string; // YYYY-MM-DD format recommended for consistency
  // Add other relevant invoice fields like line items, vendor details, etc.
}

/**
 * Defines the structure of the simulated OCR result.
 */
export type OCRResult = {
  text: string; // The full text extracted by OCR
  confidence: number; // Confidence score of the OCR process (0.0 - 1.0)
  language: string; // Detected language of the document
};

/**
 * Represents a document as it moves through the processing pipeline.
 * This interface holds all relevant information and state for a single document.
 */
export interface Document {
  id: string; // Unique identifier for the document (UUID recommended)
  filename: string; // Original filename of the uploaded document
  originalContent: Buffer; // The binary content of the document (e.g., image, PDF).
                           // In a real application, this would typically be a reference (URL)
                           // to a blob storage service (e.g., AWS S3, Azure Blob Storage).
  status: DocumentStatus; // Current processing status of the document
  ocrResult?: OCRResult; // Optional: Result from the OCR simulation
  extractedMetadata?: InvoiceMetadata; // Optional: Structured data extracted after OCR and parsing
  validationErrors?: string[]; // Optional: List of errors if validation fails
  createdAt: string; // ISO 8601 string when the document was first uploaded
  updatedAt: string; // ISO 8601 string when the document's status or data was last updated
}