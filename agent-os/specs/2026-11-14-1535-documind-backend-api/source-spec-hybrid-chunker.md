# Source Change Request — Use Docling HybridChunker (r3)

> Provided by the user on 2026-11-14. Kept verbatim; applied in `plan.md` (r3).

Update the DocuMind AI Backend API implementation plan to use **Docling HybridChunker instead of a custom chunking algorithm**.

### Required changes

1. Use Docling's `DocumentConverter` to extract PDF/DOCX documents into a structured `DoclingDocument`.
2. Use Docling's `HybridChunker` to generate token-aware chunks directly from the `DoclingDocument`.
3. Configure the chunker's tokenizer and maximum token budget based on the selected LLM provider/model, accounting for system prompts, instructions and output-token limits.
4. Use HybridChunker's structural awareness to preserve headings, section context and table information.
5. Use `chunker.contextualize()` when preparing chunks for LLM requests.
6. Do not implement a separate custom heading-based, paragraph-based or sentence-based chunking algorithm. Keep `chunking_service.py` as a thin wrapper around HybridChunker.
7. If the extracted document fits within the model's usable input budget, process it with a single LLM request. Otherwise, use Map-Reduce:
   - Map: Summarize each HybridChunker-generated chunk independently.
   - Reduce: Combine intermediate summaries into the final structured `SummaryResult`.
   - Use hierarchical reduction if intermediate summaries exceed the reduce input budget.
8. Use bounded concurrency for map requests and retain existing Bedrock primary / Groq fallback, retry and Pydantic validation logic.
9. Save the original uploaded PDF/DOCX/TXT and extracted Markdown separately in S3.
10. Persist generated chunks and relevant metadata in S3 so Q&A and re-summarization can reuse them without rerunning Docling or HybridChunker.
11. Track estimated and actual token usage where available. Do not claim that chunking reduces total input-token consumption.

### Important
- Apply these changes to Task 6 (AI Integration) and any affected architecture, file structure, configuration, standards and implementation instructions.
- Keep the existing API contracts, database design, upload flow, SQS processing architecture and Bedrock/Groq fallback decisions unchanged unless an adjustment is strictly necessary.
- Do not modify the separate Next.js frontend repository.
- Do not start implementation yet. Update the existing specification and implementation plan first, and clearly identify all affected files and decisions.
