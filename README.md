# Document Processing Pipeline Prototype

This project implements a multi-stage document processing pipeline, demonstrating key concepts like asynchronous processing, modularity, and error handling. The primary goal is to simulate the flow of documents (specifically invoices in this prototype) from upload through OCR, validation, and final persistence.

## Architecture & Design

The pipeline is designed with a microservices-like approach, where each stage is an independent process communicating via a message queue. This architecture provides:

- **Modularity:** Clear separation of concerns for each processing step.
- **Scalability:** Each stage can be scaled independently by running multiple instances.
- **Asynchronous Processing:** Operations are non-blocking, improving overall throughput.
- **Resilience:** Message queues (Redis Streams) ensure message durability and provide mechanisms for retries and dead-letter handling.

### Pipeline Flow

1.  **Document Upload:** Documents are received via an HTTP API endpoint. The document content and initial metadata are stored in Redis, and a message is published to the `document_queue` Redis Stream.
2.  **OCR Simulation:** A dedicated processor consumes messages from `document_queue`. It fetches the document, simulates OCR (using a provided mock function), updates the document with OCR results, and publishes a message to the `ocr_result_queue`.
3.  **Validation:** Another processor listens to `ocr_result_queue`. It extracts structured metadata (e.g., invoice number, total amount) from the simulated OCR text and validates the presence of required fields. It updates the document status and extracted metadata, then publishes to `validation_queue`.
4.  **Persistence:** The final processor consumes from `validation_queue`. If the document is validated, it marks the document as persisted and optionally cleans up temporary data. In a real-world scenario, this would involve storing data in a dedicated database and/or cloud storage.

### Technology Choices

- **TypeScript:** Chosen for its strong typing, which enhances code quality, maintainability, and reduces runtime errors.
- **Node.js:** The runtime environment, leveraging its asynchronous, event-driven nature for efficient handling of I/O operations.
- **Redis:** Utilized for both the message queue (Redis Streams) and temporary/final document storage. This simplifies the infrastructure for a prototype, as suggested by the challenge.
  - **Redis Streams:** Provide robust messaging with consumer groups, message acknowledgment, and persistence, crucial for reliable asynchronous processing.
  - **Redis Hashes/Strings:** Used to store document metadata and original content.
- **Express.js:** A minimal web framework used for the document upload API endpoint.
- **Multer:** Middleware for handling `multipart/form-data` for file uploads.
- **`ioredis`:** A high-performance Redis client for Node.js.
- **`uuid`:** For generating unique document IDs.
- **`dotenv`:** To manage environment variables.
- **`concurrently`:** To run multiple Node.js processes simultaneously during development.
- **`nodemon`:** For automatic restarts during development.

## Setup & Running

### Prerequisites

- Node.js (LTS recommended)
- npm (or yarn)
- Redis server (running locally or accessible via `REDIS_URL`)

### Steps

1.  **Clone/Create the Project:**
    Create a folder named `document-pipeline` and set up the directory structure as described above. Copy the content of each file into its respective location.

2.  **Install Dependencies:**
    Navigate to the containing directory in your terminal and run:

    ```bash
    npm install
    # or
    # yarn install
    ```

3.  **Start Redis Server:**
    Ensure your Redis server is running. If you're running it locally, the default `REDIS_URL=redis://localhost:6379` in `.env` will work or in case of docker image, run it and connect with different url and port

4.  **Run the Pipeline Components:**

    **Development Mode (with auto-restart):**
    This will start all services and restart them on file changes.

    ```bash
    npm run dev:all
    ```

    You will see logs from the Upload Service, OCR Processor, Validation Service, and Persistence Service in your console.

    **Production Mode (without auto-restart):**

    ```bash
    npm run start:all
    ```

    Alternatively, you can run each service in a separate terminal window:

    ```bash
    npm run start:upload
    npm run start:ocr
    npm run start:validation
    npm run start:persistence
    ```

### Interacting with the Pipeline (Upload)

Once all services are running, the Document Upload service will be listening on `http://localhost:3000`.

You can upload a document (e.g., a sample invoice image or PDF) using a tool like `curl` or Postman/Insomnia.

**Using `curl`:**

```bash
curl -X POST -F "document=@/path/to/your/invoice.pdf" http://localhost:3000/upload
```

Replace "/path/to/your/invoice.pdf" with the actual path to your document file.

like:

```bash
curl -X POST -F "document=@/Users/toni/Downloads/SomeInvoce.pdf" http://localhost:3000/upload
```
