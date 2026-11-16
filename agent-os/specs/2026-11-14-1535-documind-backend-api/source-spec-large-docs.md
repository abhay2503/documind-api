# Source Requirement Addendum — Large Document Processing & Token-Based Chunking

> Provided by the user on 2026-11-14. Kept verbatim; shaped decisions live in `plan.md` ("Large document processing") and `shape.md`.

### Large Document Processing & Token-Based Chunking

Implement token-aware document processing to support large PDFs and DOCX files.

**1. Preserve Original and Extracted Files**
- Store the original uploaded PDF/DOCX/TXT in S3.
- Use Docling to extract PDF/DOCX content into Markdown.
- Read TXT files directly as UTF-8.
- Save extracted Markdown separately in S3 at `extracted/{documentId}.md`.
- Store the extracted Markdown S3 key in `summary_jobs.extracted_content_key`.
- Never replace or delete the original uploaded document during extraction.

**2. Token Estimation & Chunking**
- Perform token estimation on extracted Markdown, not original PDF file size.
- Initially use an approximate 4 characters per token estimation strategy.
- Keep token budgets configurable through environment variables.
- Do not hardcode an assumed 8,000-token limit. Determine the usable input budget based on the selected LLM provider/model, context window, prompt overhead and output-token reservation.
- If the document fits within the available input budget, process it in a single LLM request.
- If it exceeds the budget, split it into chunks.

**3. Intelligent Chunking**
- Use Docling's Markdown headings and document sections as preferred splitting boundaries.
- Combine smaller sections until the chunk reaches its token budget.
- Split oversized sections further using paragraphs and sentence boundaries.
- Preserve heading/context information in each chunk.
- Support configurable chunk overlap where appropriate.
- Never truncate the document simply because it exceeds the model's context window.

**4. Map-Reduce Summarization**
- Map stage: Send each chunk independently to the selected LLM provider and generate intermediate summaries.
- Reduce stage: Combine intermediate summaries and generate the final structured summary.
- If intermediate summaries exceed the reduce input budget, implement hierarchical/multi-level reduction.
- Use bounded concurrency to control API costs and provider throttling.
- Apply provider retries and Bedrock-to-Groq fallback to map and reduce requests.
- Validate the final output using the existing Pydantic SummaryResult schema.

**5. Token Usage & Cost Considerations**
- Understand that chunking does not reduce the original document's total input tokens.
- Track estimated input tokens and, where available, actual provider token usage.
- Account for additional tokens used by intermediate summaries, reduction prompts and retries.
- Do not claim token savings from chunking.

**6. Reuse Extracted Markdown**
- Reuse the stored Markdown for follow-up Q&A and re-summarization.
- Do not run Docling extraction again when valid extracted Markdown already exists.
- Keep the original document available for future reprocessing.

**Example:** A document containing approximately 40,000 tokens with an illustrative 8,000-token chunk budget would produce approximately five map chunks, followed by a reduce stage. Actual chunk sizes and request counts depend on section boundaries and model configuration.
