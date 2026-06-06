# Copilot: extract

Smoke-test the resume/JD parsing endpoint by uploading a local file to
`POST /api/documents/extract` and printing the extracted text.

Pass the path to a `.pdf`, `.docx`, or `.txt` file as extra input, then run from
the repo root (substitute the path for `<file>`):

```bash
./copilot extract <file>
```

Requires the API to be up on :8000 (`/copilot-start` or `/copilot-api` first).
If no file path was provided, ask the user which file to test.
