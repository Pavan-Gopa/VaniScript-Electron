Place packaged `llama.cpp` runtime binaries in this directory.

Expected layout:
- `vendor/llamacpp/darwin-arm64/llama-cli`
- `vendor/llamacpp/darwin-x64/llama-cli`
- `vendor/llamacpp/linux-x64/llama-cli`
- `vendor/llamacpp/linux-arm64/llama-cli`
- `vendor/llamacpp/win32-x64/llama-cli.exe`
- `vendor/llamacpp/win32-arm64/llama-cli.exe`

The runtime directory should also contain the sibling `libllama` / `libggml` shared libraries from the same official release archive.

Bootstrap the current platform runtime with:

```bash
npm run install:llamacpp-runtime
```

During development, `VaniScript` falls back to a system `llama-cli` if present.
