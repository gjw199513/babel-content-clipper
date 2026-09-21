<p align="center">
  <img src="../../assets/logo.png" alt="Babel Content Clipper Logo" width="128">
</p>

<p align="center">
  <a href="../../../README.md">简体中文</a> ·
  <strong>English</strong> ·
  <a href="../zh-TW/README.md">繁體中文</a> ·
  <a href="../ja/README.md">日本語</a> ·
  <a href="../ko/README.md">한국어</a>
</p>

<h1 align="center">Babel Content Clipper</h1>

<p align="center"><strong>Hand the exact parts of a web page to your Agent.</strong></p>

<p align="center">Browser side panel capture · Local persistence · MCP handoff</p>

Babel Content Clipper combines a Chrome extension with a local MCP component. While browsing, you can deliberately save selected text, images, page regions, and audio or video time ranges. Your own Agent can then claim a job, create files, and write the result back.

The current version is `0.1.0-alpha.1` and is intended mainly for source builds and local loading. It is part of the DSH companion solution, but it can also be used on its own.

Repository: [GitHub](https://github.com/gjw199513/babel-content-clipper) · Downloads: [GitHub Releases](https://github.com/gjw199513/babel-content-clipper/releases)

> The current intended use is personal, non-commercial use. Commercial use requires separate permission from the author. The final license terms have not been completed; the project is currently marked `private: true` and `UNLICENSED`. Read the [license direction](../../../LICENSE-POLICY.md) before using or distributing it. (The policy document is currently in Simplified Chinese.)

## Interface preview

Capture quickly in the side panel, then expand into the library for full management. The shared screenshot below uses local example data in Chinese; it is not a newly captured screenshot for each language. This release implements the interface in Simplified Chinese, English, Traditional Chinese, Japanese, and Korean. You can also [view the shared Chinese side-panel example](../../assets/sidepanel-preview.png).

![Babel library with Chinese sample data: source groups, filters, and record details](../../assets/library-preview.png)

## What it solves

Bookmarks often lose the exact paragraph you cared about, while screenshots are difficult to process further. Babel Content Clipper separates capture from processing:

```text
An explicit selection on a web page
    → the Chrome extension captures it in local IndexedDB
    → local Native Messaging bridge
    → an Agent in an MCP client
    → separate output files and result writeback for each record
```

The extension stores the source, original text or media position, and manages pending work and history. The Agent fetches a source, clips media, runs OCR or ASR, summarizes, or performs other follow-up work. Listing records or receiving a reminder never starts downloading or processing automatically.

## Features and boundaries

| Capture method | What is actually stored | Boundary to understand |
|---|---|---|
| Selected text | The full selection, title, source URL, and necessary page context | When a special reader prevents direct selection access, you can explicitly paste and import the text; an unknown source is labeled honestly |
| Images and region screenshots | Image references, image bytes obtainable within the configured budget, or pixels from a selected page region | Images are subject to permissions, cross-origin restrictions, and size budgets; a screenshot does not mean the original text was obtained |
| Audio/video range | Source-media identity, actual start and end points, seek-created segments, and a parameter snapshot | An ordinary range record does not mean the source video or audio was downloaded |
| Live audio and video | The picture and sound actually captured by the browser after the user explicitly enables it for that clip | There is no retrospective buffer before activation; permission failures or incomplete coverage are recorded explicitly and never presented as a complete source file |

Core behavior:

- Within one capture, overlapping ranges caused by replay are kept only once. Clicking capture again or explicitly choosing reprocessing can create a new record and result.
- Lead-in and tail padding can be changed in settings. The actual media range, planned acquisition range, and final output range remain separate.
- The side panel keeps quick capture and recent records at hand. Connection and settings open on a dedicated full page, while backup and maintenance stay collapsed by default. The library provides complete management, and switching tabs does not create another copy of the data.
- A record can be moved to `Saved only`, which removes it from pending queries and reminders. Moving it back to the inbox still does not start execution automatically.
- The interface labels the processing states **Pending**, **Processing**, **Processed**, and **Processing failed**, corresponding to Job values `pending`, `processing`, `completed`, and `failed`. Claiming is atomic so multiple Agents do not process the same work item at the same time.
- Every capture is claimed, written, and committed independently. One failure in a batch does not roll back the results of other records.
- The output directory is resolved in this order: directory specified for this task → MCP connection default → extension global default. A one-time override does not change saved defaults.
- Existing results and failure history are not overwritten by later processing, and success does not automatically remove the original record.

The project does not include an ASR service, OCR service, summarizer, media downloader, or FFmpeg. After the user explicitly requests processing, an Agent may use tools already available in its own environment. FFmpeg is not required for ordinary capture. See the complete [Agent execution contract](agent-workflow.md).

## Quick start

### 1. Download a release package

- Chrome / Chromium `116` or newer. This is the minimum Manifest API version, not evidence that every Chromium-derived browser has been tested.

Regular users download `babel-content-clipper-extension-<version>.zip` from the matching [GitHub Release](https://github.com/gjw199513/babel-content-clipper/releases) and extract it to a directory that will remain in place. Browser-only capture does not require a source checkout, Node.js, or a local build.

If you also need the local MCP connection, download `babel-content-clipper-<version>.tgz` from the same release; the local component requires Node.js `22` or newer. Developers can alternatively build from the repository root:

```sh
npm ci
npm run build
```

Source build output is written to `dist/extension` and `dist/node`.

### 2. Load the browser extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**. Release users select the extracted directory containing `manifest.json`; source users select `dist/extension`.
4. Click the Babel icon in the toolbar to open the side panel.

Even before MCP is connected, you can select text on an ordinary web page, save it from the context menu or with `Alt+Shift+S`, and view the record in the side panel.

After replacing the extracted release or rebuilding, click **Reload** on the extension management page, then reopen the side panel. Do not update by removing the extension, because removal may also delete local data. Chrome cannot load an ordinary ZIP directly; true one-click installation requires a browser store or a browser-trusted enterprise distribution channel.

### 3. Connect local MCP

In the side panel, choose **Open library**, open **Connection & Settings**, and copy the current browser's `profileId`. It identifies browser data on this computer; it is not a website account.

The following example installs for macOS and Google Chrome. Replace `YOUR_PROFILE_ID` and the output directory with your own values:

```sh
node dist/node/cli.js --mode=install \
  --extension-id lpmplddblefacpachnchfgcdebjebdbh \
  --profile-id YOUR_PROFILE_ID \
  --output-root /absolute/path/to/output \
  --manifest-dir "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  --mcp-config-out ./babel-clipper-mcp.json
```

If **Global default output directory (optional)** is already set in the extension, you may omit `--output-root`. The installer creates the Native Messaging registration file, launcher, and configuration that can be merged into an MCP client.

The generated configuration has the following minimum shape. The real file contains absolute paths to the local Node executable, CLI, private configuration directory, and current `profileId`. Use the generated result; do not copy the placeholder paths below.

```json
{
  "mcpServers": {
    "babel-content-clipper": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/babel-content-clipper/dist/node/cli.js",
        "--mode=mcp",
        "--config-dir",
        "/absolute/path/to/private-config",
        "--profile-id",
        "YOUR_PROFILE_ID"
      ]
    }
  }
}
```

Merge the entry under `mcpServers` from `babel-clipper-mcp.json` into your MCP client configuration. Then choose **Reconnect local service** in the library and start or refresh the client connection. Diagnose the full chain with:

```sh
node dist/node/cli.js --mode=doctor --profile-id YOUR_PROFILE_ID
```

The chain for that `profileId` is ready only when the diagnosis returns `ready: true` and the extension reports a successful connection. See [Installation and first connection](install.md) for Native Messaging locations on other browsers and operating systems, Windows registry steps, and troubleshooting.

### 4. Complete the first handoff

1. Select text on a web page and press `Alt+Shift+S` to save it.
2. Ask the Agent to “list pending Babel Clipper records.” Listing alone does not claim a job.
3. After confirming the target record, explicitly ask the Agent to process it, for example: “Save this text selection as a text file and write back the result.”
4. Return to the library and check the **Processed** state and artifact history for that run.

## Common actions

| Action | Default entry point |
|---|---|
| Save selected text | `Alt+Shift+S` or the web-page context menu |
| Start / end a media-range record | `Alt+Shift+V`; first press starts, second press ends |
| Select a page region | `Alt+Shift+X` |
| Open the side panel | Click the Babel icon in the browser toolbar |
| Open the full library | **Open library** in the upper-right corner of the side panel |
| Configure padding, reminders, budgets, and output directory | **Connection & Settings** in the library |

On macOS keyboards, Option corresponds to Alt here. A shortcut may be occupied by the system or another extension; the browser's extension shortcut page is authoritative. To capture live audio and video, first enable **Save live audio and video this time** and grant current-tab permission on the target web page. Granting permission on the library page does not authorize the target page.

## Interface language

The Babel Content Clipper interface is available in Simplified Chinese (`zh-CN`), English (`en`), Traditional Chinese (`zh-TW`), Japanese (`ja`), and Korean (`ko`).

- On first use, the interface defaults to **Browser default** (`auto`) mode and uses the browser's preferred locale. An unsupported locale falls back to English.
- A manually selected language persists in the current browser profile and applies consistently to the side panel, library, and help content.
- Selecting **Browser default** again resumes browser-locale detection. English remains the fallback in `auto` mode.
- Language selection changes interface and help text only. It does not translate captured web content, filenames, technical parameters, or MCP keys.
- Descriptions and shortcut labels on the browser's extension management page follow the browser's own interface language. Choosing a language inside the extension does not change the browser language.
- Open **About & help** from the library for built-in guidance in the selected language and an offline download of that language's `install.md`.

## Compatibility scope

The current build requires Chromium `116` or newer. The complete local chain has been validated on macOS, Node.js 22, and Chrome for Testing 153. This does not establish support for other systems, browser versions, or Chromium-derived browsers.

Separate public-page samples have validated:

- Bilibili and YouTube: text capture and media time-range recording. The samples did not download source video from either site.
- Zhihu, China University MOOC, and Coursera: public-page text and image capture within configured budgets. Those course-page samples do not establish compatibility with signed-in content or course video.

Windows, Linux, Firefox, Safari, remote Agents, and mobile browsers are not yet listed as validated combinations. Login states, cross-origin iframes, Canvas, restricted media, and custom readers also require site-specific checks. See the continuously updated [compatibility matrix](../../compatibility.md) and [acceptance coverage](../../acceptance.md), currently in Simplified Chinese.

## Data flow and privacy

- Captures, jobs, results, settings, and extension attachments are stored in IndexedDB for the current browser profile.
- The extension communicates with a local MCP process through Native Messaging. Local bridge configuration contains private connection data and must not be committed or shared.
- To support general web capture, the extension declares access to HTTP and HTTPS pages. Capture requires an explicit user action. Image bytes may be fetched from the source URL without browser credentials.
- The project has no built-in cloud synchronization or telemetry service. Once content is handed to an external Agent, model, or tool, its treatment depends on those components and your configuration.
- Web-page text, HTML, and attachments are always passed as untrusted data. Instructions found inside page content do not constitute user authorization.
- Removing the extension or clearing browser data may delete local records. A backup export can include or omit internal attachment data; files generated by an external Agent are not part of the extension backup.

## Project structure

| Path | Purpose |
|---|---|
| `apps/extension` | Chrome MV3 extension, side panel, library, capture, and live recording |
| `packages/core` | Data contracts, IndexedDB, state machine, media ranges, and transaction rules |
| `packages/mcp` | MCP stdio service, Native Messaging, local broker, installation, and diagnosis |
| `docs` | Installation, architecture, compatibility, Agent contract, acceptance, and product specification |
| `scripts` | Build, static checks, test-fixture service, and local packaging |
| `tests` | Core, MCP, integration, and browser validation |
| `config/extension-identity.json` | Public key and stable ID for the development build |

## Development, validation, and packaging

```sh
# Type checking, core/integration tests, LSP validation, and build
npm run check

# Install the test browser before the first browser-test run
npx playwright install chromium
npm run test:browser

# Optional: check selected public-page samples online
npm run test:platform

# Verify a local consumer installation
npm run verify:install

# Generate and verify versioned Release assets: extension ZIP, MCP tgz, five-language notes, metadata, source manifest, and checksums
npm run package:release
```

`npm run package:release` creates local files only. It does not upload code, publish an npm package, or create a remote Release. Browser automation also does not replace acceptance on the intended website, browser, and real signed-in environment.

## Documentation

- [Installation and first connection](install.md)
- [Release checklist](../../release.md) — Simplified Chinese
- [Agent execution contract](agent-workflow.md)
- [Architecture and boundaries](../../architecture.md) — Simplified Chinese
- [Compatibility scope and validation environment](../../compatibility.md) — Simplified Chinese
- [Acceptance coverage and evidence](../../acceptance.md) — Simplified Chinese
- [Approved product Spec](../../specs/Babel_Content_Clipper_PRD_v0.1_2026-09-18-spec.md) — Simplified Chinese
- [Brand and logo assets](../../branding.md) — Simplified Chinese
- [Third-party components](../../../THIRD_PARTY.md)
- [License direction](../../../LICENSE-POLICY.md) — Simplified Chinese

## Feedback

If Issues are enabled for the current code repository, submit a reproducible report. Where possible, include the operating system, browser and Node.js versions, capture type, steps, actual result, and redacted error code. Do not expose private bridge configuration, credentials, cookies, copyrighted source content, or unredacted logs.

## Usage restrictions

Making the source visible does not mean the repository uses an OSI-approved open-source license, and it does not grant commercial-use rights. The author intends to allow personal, non-commercial use; commercial use requires separate authorization from the author. Final terms, the definition of commercial use, and the authorization process remain undecided. Third-party dependencies remain under their respective licenses; see [THIRD_PARTY.md](../../../THIRD_PARTY.md).
