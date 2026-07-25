# API Probe Lab 1.2.1 Windows artifacts

- `API Probe Lab 1.2.1.exe` is the portable Windows x64 executable.
- The ZIP distribution is split into GitHub-compatible parts because GitHub
  rejects individual repository files larger than 100 MB.

To restore the ZIP, place both `.part-*` files in this directory and join them
in filename order:

```powershell
cmd /c copy /b "API Probe Lab-1.2.1-win.zip.part-aa"+"API Probe Lab-1.2.1-win.zip.part-ab" "API Probe Lab-1.2.1-win.zip"
```
