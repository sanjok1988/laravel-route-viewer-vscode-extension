
# Laravel Route Viewer

   View and search Laravel routes in a beautiful UI inside VS Code.

   Usage
   - Run the command: "Laravel: Show Routes (UI)" from the command palette.
   - Configure php/artisan path in Settings -> Extensions -> Laravel Route Viewer if needed.

   Configuration
   - laravelRouteViewer.phpPath: Path to PHP executable (default: php)
   - laravelRouteViewer.artisanPath: Path to artisan relative to workspace folder (default: artisan)

   License: MIT

Commands to update and re-run packaging
- Edit README.md in your editor or from shell:
  - Linux/macOS:
    echo "# Laravel Route Viewer\n\nView and search Laravel routes in a beautiful UI inside VS Code.\n\nUsage: Run 'Laravel: Show Routes (UI)' in Command Palette." > README.md
  - Windows PowerShell:
    Set-Content -Path README.md -Value "# Laravel Route Viewer`n`nView and search Laravel routes in a beautiful UI inside VS Code.`n`nUsage: Run 'Laravel: Show Routes (UI)' in Command Palette."

- Recompile and package:
  npm run compile
  npx vsce package --out laravel-route-viewer.vsix

Other checks if packaging still fails
- package.json must have at least: name, displayName, version, description, engines.vscode. Example:
  {
    "name": "laravel-route-viewer",
    "displayName": "Laravel Route Viewer",
    "version": "0.0.1",
    "description": "View and search Laravel routes in VS Code.",
    "engines": { "vscode": "^1.50.0" }
  }
- Ensure compiled output (out/) exists and is not excluded by .vscodeignore.
- If the error message changes, paste the full packaging output here and I’ll diagnose the exact cause.

If you want, paste your current README.md contents and package.json and I’ll point out the exact lines to change.