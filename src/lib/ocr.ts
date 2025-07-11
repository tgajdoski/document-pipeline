// src/lib/ocr.ts

import { OCRResult } from "../types/document";

/**
 * Simulates an Optical Character Recognition (OCR) process.
 * In a real application, this would call an external OCR service API
 * (e.g., Google Cloud Vision, Azure AI Document Intelligence).
 *
 * @param imageBuffer The buffer of the document image (or PDF, etc.).
 * @returns A Promise that resolves with an OCRResult object.
 */
export function simulateOCR(imageBuffer: Buffer): Promise<OCRResult> {
  return new Promise((resolve) => {
    // Simulate a network/processing delay for the OCR operation
    setTimeout(() => {
      // For the purpose of this prototype, we return a fixed, but
      // contextually relevant, simulated text for an invoice.
      const simulatedText = `
        Invoice Number: INV-2025-001
        Customer: Acme Corp
        Date: 2025-07-08
        Total: 1234.56 USD
        Currency: USD
        Description: Consulting Services
        Item 1: Product A - 10 units @ 50.00 USD
        Item 2: Product B - 5 units @ 100.00 USD
        Tax: 100.00 USD
        Subtotal: 1134.56 USD
        Vendor: Example Solutions Inc.
        Address: 123 Business Rd, City, Country
        VAT ID: GB123456789
      `;
      resolve({
        text: simulatedText,
        confidence: 0.98, // High confidence for a successful simulation
        language: "en",
      });
    }, 500); // 500ms delay
  });
}