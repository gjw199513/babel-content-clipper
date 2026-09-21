# Installation and first connection

[简体中文](../../install.md) · [English](install.md) · [繁體中文](../zh-TW/install.md) · [日本語](../ja/install.md) · [한국어](../ko/install.md)

This guide uses the `0.1.0-alpha.1` command-line interface. See the [compatibility matrix](../../compatibility.md) for the systems, browsers, and clients that have actually been validated. This is a development candidate and has not been published to npm.

## 1. Download a release package or prepare the source

Regular users should download `babel-content-clipper-extension-0.1.0-alpha.1.zip` from the matching [GitHub Release](https://github.com/gjw199513/babel-content-clipper/releases) and extract it to a directory that will remain in place. Browser-only capture does not require a source checkout, Node.js, or a local build.

To connect local MCP, also download `babel-content-clipper-0.1.0-alpha.1.tgz` from the same Release. The local component requires Node.js 22 or newer; confirm that `node --version` runs successfully. Browser capture itself does not depend on FFmpeg. If an Agent needs to clip audio or video, it can use media tools already available in its own execution environment.

Build from the source directory:

```sh
npm ci
npm run build
```

To install the MCP package from the Release, run the following command in your own installation directory. Replace the filename with the actual downloaded package path.

```sh
npm install /absolute/path/babel-content-clipper-0.1.0-alpha.1.tgz
```

With a source build, the local component is `dist/node/cli.js`. With the package installation, it is `node_modules/babel-content-clipper/dist/node/cli.js`. The rest of this guide uses the source-build relative path; run the commands from the source root.

## 2. Load the extension and get the connection identifier

Turn on **Developer mode** on the browser extension management page and choose **Load unpacked**. For a source build, select `dist/extension`. For a Release build, select the extracted directory that contains `manifest.json`. Chrome cannot load an ordinary ZIP directly; no source is needed, but the ZIP must be extracted first. True one-click installation requires a browser store or a browser-trusted enterprise distribution channel.

Open the Babel side panel, choose **Open library**, then open **Connection & Settings**. Copy the browser connection identifier shown as `profileId`. It distinguishes browser data stores; it is not a website account.

The extension ID for this build is `lpmplddblefacpachnchfgcdebjebdbh`. Still compare it with the ID displayed on the extension management page. If you change the build key, you must use your own ID.

At this point, you can select text on an ordinary web page and save it with the context menu or `Alt+Shift+S`. The extension should save and display records even before MCP is connected.

After rebuilding the source or replacing the extension build, click **Reload** for this extension on the management page and reopen the side panel. Reopening a browser window alone does not prove that the new code is loaded. Do not delete extension data as an update method.

## 3. Install the local bridge and generate client configuration

Replace `YOUR_PROFILE_ID` below with the connection identifier from the previous step. The installer creates a Native Messaging registration file, launcher, and MCP configuration example. It protects existing files by default. If it returns `INSTALL_TARGET_EXISTS`, first confirm that the files belong to this installation; use `--overwrite` only when updating your own earlier installation.

macOS / Google Chrome:

```sh
node dist/node/cli.js --mode=install \
  --extension-id lpmplddblefacpachnchfgcdebjebdbh \
  --profile-id YOUR_PROFILE_ID \
  --manifest-dir "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  --mcp-config-out ./babel-clipper-mcp.json
```

For Chromium, change `--manifest-dir` to `$HOME/Library/Application Support/Chromium/NativeMessagingHosts`. For Edge, use `$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts`. Each browser reads its own registration directory.

On Linux, typical paths are `$HOME/.config/google-chrome/NativeMessagingHosts`, `$HOME/.config/chromium/NativeMessagingHosts`, or `$HOME/.config/microsoft-edge/NativeMessagingHosts`. Distribution channels may use different directories. Linux still requires device validation according to the compatibility matrix.

On Windows, use the same CLI to generate the files, then set the default value of the current user's Native Messaging host registry key for the relevant browser to the generated JSON file's absolute path. The CLI output under `manualBrowserLocations` lists the corresponding registry keys. Host startup and registration have not yet been validated on Windows; generating the files alone does not establish support.

On success, the terminal returns JSON containing `nativeHost.manifestPath`, `nativeHost.launcherPath`, and `mcpConfig.path`. Do not move or delete the component installation directory. The generated configuration uses absolute paths.

Merge the entry under `mcpServers` from `babel-clipper-mcp.json` into your client's MCP configuration. MCP configuration locations and outer formats differ by client, so use the client's MCP settings entry point. The generated `command` is the absolute path to the local Node executable. Its arguments contain the component path, configuration directory, and `profileId`; no path from the author's computer is required.

Choose one of these ways to set the output directory:

- Set **Global default output directory (optional)** under **Connection & Settings** in the library.
- Add `--output-root /absolute/path/to/output` during installation to save an MCP default. You can also add `--output-root` to one client's MCP launch arguments to override the default for that connection only.
- Have the user or Agent explicitly provide an absolute directory for one processing task.

Resolution order is task directory, MCP default, then extension global default. A one-time override does not change defaults. If an explicitly supplied directory is unusable, the operation reports an error rather than silently saving elsewhere.

For example, one client can use a separate connection default:

```sh
node dist/node/cli.js --mode=mcp --profile-id YOUR_PROFILE_ID --output-root /absolute/path/to/client-output
```

This is the stdio service launch command and is normally run by the MCP client. It does not change the extension's global setting or the configuration of other clients.

## 4. Check the complete connection

After installation, choose **Reconnect local service** under **Connection & Settings** in the library, and start or refresh the client's MCP connection. Then run:

```sh
node dist/node/cli.js --mode=doctor --profile-id YOUR_PROFILE_ID
```

If installation used `--config-dir`, supply the same argument during diagnosis. The selected profile's full connection is ready only when the result contains `ready: true` and the extension diagnosis succeeds. A missing browser connection, bad configuration, and a host that has not started produce separate states.

Ask the Agent to “list pending Babel Clipper records.” Listing alone does not claim or process a job. After confirming that the Agent can read the text selection you just saved, explicitly ask it to “save this text selection as a text file and write back the result.” The Agent claims the Job, stores the artifact, and commits the result according to the [execution contract](agent-workflow.md). The library should then show **Processed** and the history for that run.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `PROFILE_REQUIRED` or a profile mismatch | Copy `profileId` from the current browser's library and check the client arguments. Do not use a profile from another test or browser. |
| Native Host not found | Check that the registration directory belongs to the current browser, that the JSON contains the correct extension ID, and that the launcher path and execute permission are valid; then reconnect. |
| `BROKER_UNAVAILABLE` | Start the extension's local connection or the MCP client. Doctor checks state; it does not start the bridge in the background. |
| `BROWSER_UNAVAILABLE` | Keep the corresponding browser and extension running, and inspect the local-service state in the library. This error does not mean the pending list is empty. |
| `WRITEBACK_UNACKNOWLEDGED` or a disconnect during writeback | Keep the original `requestId` and identical result payload, reconnect, and retry idempotently. Do not claim completion before receiving a persisted ACK. |
| A job remains processing after the Agent disconnects | First determine whether the original execution is still running. The system does not automatically release or duplicate work after a timeout. |
| The page cannot be captured | Browser-internal pages, permission-restricted pages, and special readers may be inaccessible. Use an explicitly labeled fallback; a screenshot does not become original text. |
| `TAB_CAPTURE_PERMISSION_REQUIRED` | Return to the web page you want to record, click the Babel extension icon in the browser toolbar, and enable live saving for this clip. You can also first capture a real selection on that page with the actual shortcut and then start recording directly from the side panel; that path passed current acceptance. Permission must be requested on the target web page. Requesting it on the library page does not authorize the video page. Request again after an extension reload. A redacted reason is saved in failure details; if recording does not start, the result is only a recorded time range. |
| Wrong output directory | Check the effective highest-priority directory and the current operating-system user's permissions. The same directory does not need to be configured twice. |

Removing the extension or deleting browser data affects local material. Before moving to a new profile, export a backup and confirm whether it includes attachment bytes. A metadata-only backup cannot restore images or recordings. Artifacts created by an external Agent are not included in the extension attachment backup.
