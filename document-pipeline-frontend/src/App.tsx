import React, { useState, useEffect, useRef, ChangeEvent } from 'react';

// Define types that mirror your backend's document.ts
type DocumentStatus =
  | "UPLOADED"
  | "OCR_PENDING"
  | "OCR_COMPLETED"
  | "OCR_FAILED"
  | "VALIDATION_PENDING"
  | "VALIDATED"
  | "VALIDATION_FAILED"
  | "PERSISTENCE_PENDING"
  | "PERSISTED"
  | "FAILED";

interface OCRResult {
  text: string;
  confidence: number;
  language: string;
}

interface InvoiceMetadata {
  invoiceNumber: string;
  customerName: string;
  totalAmount: number;
  currency: string;
  issueDate: string;
}

interface Document {
  id: string;
  filename: string;
  status: DocumentStatus;
  ocrResult?: OCRResult;
  extractedMetadata?: InvoiceMetadata;
  validationErrors?: string[];
  createdAt: string;
  updatedAt: string;
}

const API_BASE_URL = 'http://localhost:3000'; // backend API URL

function App(): JSX.Element { 
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadedDocumentId, setUploadedDocumentId] = useState<string | null>(null);
  const [documentStatus, setDocumentStatus] = useState<DocumentStatus | null>(null);
  const [ocrResult, setOcrResult] = useState<OCRResult | null>(null);
  const [extractedMetadata, setExtractedMetadata] = useState<InvoiceMetadata | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[] | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string>('');

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null); 

  const resetState = (): void => {
    setSelectedFile(null);
    setUploadedDocumentId(null);
    setDocumentStatus(null);
    setOcrResult(null);
    setExtractedMetadata(null);
    setValidationErrors(null);
    setIsLoading(false);
    setMessage('');
    setError('');
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    resetState(); 
    if (event.target.files && event.target.files.length > 0) {
      setSelectedFile(event.target.files[0]);
    } else {
      setSelectedFile(null);
    }
  };

  const handleUpload = async (): Promise<void> => {
    if (!selectedFile) {
      setError('Please select a file first.');
      return;
    }

    setIsLoading(true);
    setError('');
    setMessage('Uploading document...');

    const formData = new FormData();
    formData.append('document', selectedFile);

    try {
      const response = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData: { error?: string } = await response.json();
        throw new Error(errorData.error || 'Failed to upload document.');
      }

      const data: { message: string; documentId: string; status: DocumentStatus } = await response.json();
      setUploadedDocumentId(data.documentId);
      setDocumentStatus(data.status);
      setMessage(`Document uploaded: ${data.documentId}. Starting processing...`);
      setIsLoading(false);

      startPolling(data.documentId);

    } catch (err: any) {
      console.error('Upload error:', err);
      setError(err.message || 'An unexpected error occurred during upload.');
      setIsLoading(false);
      setMessage('');
    }
  };

  // Function to fetch document status
  const fetchDocumentStatus = async (docId: string): Promise<void> => {
    try {
      const response = await fetch(`${API_BASE_URL}/document/${docId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch document status.');
      }
      const data: Document = await response.json(); // Type the incoming data

      setDocumentStatus(data.status);
      setOcrResult(data.ocrResult || null);
      setExtractedMetadata(data.extractedMetadata || null);
      setValidationErrors(data.validationErrors || null);

      // Stop polling if the document reaches a final state
      if (['PERSISTED', 'FAILED', 'OCR_FAILED', 'VALIDATION_FAILED'].includes(data.status)) {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        setMessage(`Processing complete. Final status: ${data.status}`);
      } else {
        setMessage(`Current status: ${data.status}...`);
      }

    } catch (err: any) {
      console.error('Polling error:', err);
      setError('Failed to get real-time updates. Please check backend logs.');
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current); // Stop polling on error
        pollIntervalRef.current = null;
      }
    }
  };

  // Start polling
  const startPolling = (docId: string): void => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }
    // Poll every 2 seconds
    pollIntervalRef.current = setInterval(() => fetchDocumentStatus(docId), 2000);
  };

  // Cleanup interval on component unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center py-10 px-4">
      <div className="bg-white p-8 rounded-lg shadow-xl w-full max-w-2xl">
        <h1 className="text-3xl font-bold text-center text-gray-800 mb-6">
          Document Processing Dashboard
        </h1>

        {/* Upload Section */}
        <div className="mb-8 p-6 border border-gray-200 rounded-lg bg-gray-50">
          <h2 className="text-2xl font-semibold text-gray-700 mb-4">Upload Document</h2>
          <input
            type="file"
            onChange={handleFileChange}
            className="block w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-white focus:outline-none file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
          <button
            onClick={handleUpload}
            disabled={!selectedFile || isLoading}
            className={`mt-4 w-full py-3 px-6 rounded-lg font-semibold text-white transition-all duration-300 ${
              !selectedFile || isLoading
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50'
            }`}
          >
            {isLoading ? 'Uploading & Processing...' : 'Upload & Start Processing'}
          </button>
        </div>

        {/* Messages and Errors */}
        {message && (
          <div className="mb-4 p-3 rounded-lg bg-blue-100 text-blue-800 border border-blue-200">
            {message}
          </div>
        )}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-100 text-red-800 border border-red-200">
            Error: {error}
          </div>
        )}

        {/* Document Status and Results Display */}
        {uploadedDocumentId && (
          <div className="p-6 border border-gray-200 rounded-lg bg-white">
            <h2 className="text-2xl font-semibold text-gray-700 mb-4">Document Details</h2>
            <p className="mb-2 text-gray-600">
              <span className="font-medium">Document ID:</span> {uploadedDocumentId}
            </p>
            <p className="mb-4 text-gray-600">
              <span className="font-medium">Current Status:</span>{' '}
              <span className={`font-bold ${
                documentStatus === 'PERSISTED' ? 'text-green-600' :
                documentStatus && documentStatus.includes('FAILED') ? 'text-red-600' :
                'text-yellow-600'
              }`}>
                {documentStatus || 'N/A'}
              </span>
            </p>

            {ocrResult && (
              <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <h3 className="text-xl font-semibold text-gray-700 mb-2">OCR Result</h3>
                <p className="text-gray-600">
                  <span className="font-medium">Confidence:</span> {ocrResult.confidence?.toFixed(2)}
                </p>
                <p className="text-gray-600 mb-2">
                  <span className="font-medium">Language:</span> {ocrResult.language}
                </p>
                <div className="bg-gray-100 p-3 rounded-md text-sm text-gray-700 whitespace-pre-wrap break-words border border-gray-300">
                  <span className="font-medium block mb-1">Extracted Text:</span>
                  {ocrResult.text}
                </div>
              </div>
            )}

            {extractedMetadata && (
              <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <h3 className="text-xl font-semibold text-gray-700 mb-2">Extracted Metadata (Invoice)</h3>
                <ul className="list-disc list-inside text-gray-700">
                  {Object.entries(extractedMetadata).map(([key, value]) => (
                    <li key={key}>
                      <span className="font-medium capitalize">{key.replace(/([A-Z])/g, ' $1')}:</span> {value as React.ReactNode}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {validationErrors && validationErrors.length > 0 && (
              <div className="mt-4 p-4 bg-red-50 rounded-lg border border-red-200 text-red-800">
                <h3 className="text-xl font-semibold text-red-700 mb-2">Validation Errors</h3>
                <ul className="list-disc list-inside">
                  {validationErrors.map((err, index) => (
                    <li key={index}>{err}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;