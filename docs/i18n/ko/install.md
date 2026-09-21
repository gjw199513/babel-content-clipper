# 설치 및 첫 연결

[简体中文](../../install.md) · [English](../en/install.md) · [繁體中文](../zh-TW/install.md) · [日本語](../ja/install.md) · [한국어](install.md)

이 문서는 `0.1.0-alpha.1` 명령줄 인터페이스를 사용합니다. 실제로 검증된 운영체제, 브라우저 및 클라이언트는 [호환성 매트릭스](../../compatibility.md)(중국어 간체)를 참조하세요. 현재 버전은 개발 후보이며 npm에 게시되지 않았습니다.

## 1. 릴리스 패키지 다운로드 또는 소스 준비

일반 사용자는 해당 버전의 [GitHub Releases](https://github.com/gjw199513/babel-content-clipper/releases)에서 `babel-content-clipper-extension-0.1.0-alpha.1.zip`을 다운로드해 계속 유지할 디렉터리에 압축 해제하세요. 브라우저 수집만 사용할 때는 소스 코드, Node.js, 로컬 빌드가 필요하지 않습니다.

로컬 MCP를 연결하려면 같은 Release에서 `babel-content-clipper-0.1.0-alpha.1.tgz`도 다운로드하세요. 로컬 구성 요소에는 Node.js 22 이상이 필요합니다. `node --version`이 정상적으로 실행되는지 확인하세요. 브라우저 수집 자체는 FFmpeg에 의존하지 않습니다. Agent가 오디오나 비디오를 잘라야 할 때는 실행 환경에 이미 있는 미디어 도구를 사용합니다.

소스 디렉터리에서 빌드합니다.

```sh
npm ci
npm run build
```

Release의 MCP 패키지를 설치하려면 자신의 설치 디렉터리에서 다음 명령을 실행하세요. 파일명은 실제로 받은 설치 패키지 경로로 바꾸세요.

```sh
npm install /absolute/path/babel-content-clipper-0.1.0-alpha.1.tgz
```

소스 방식의 로컬 구성 요소는 `dist/node/cli.js`에 있고, 패키지 설치 방식은 `node_modules/babel-content-clipper/dist/node/cli.js`에 있습니다. 아래에서는 소스 방식의 상대 경로를 사용하므로 소스 루트에서 명령을 실행하세요.

## 2. 확장 프로그램 로드 및 연결 식별자 확인

브라우저 확장 프로그램 관리 페이지에서 ‘개발자 모드’를 켜고 ‘압축해제된 확장 프로그램을 로드합니다’를 선택합니다. 소스 방식은 `dist/extension`을 선택하고, Release 방식은 `manifest.json`이 들어 있는 ZIP 압축 해제 디렉터리를 선택합니다. Chrome은 일반 ZIP을 직접 로드할 수 없습니다. 소스는 필요하지 않지만 먼저 압축을 풀어야 합니다. 진정한 원클릭 설치에는 브라우저 스토어나 브라우저가 신뢰하는 기업 배포 채널이 필요합니다.

Babel 사이드 패널을 열고 ‘라이브러리 열기’를 선택한 다음 ‘연결 및 설정’을 엽니다. 표시된 브라우저 연결 식별자 `profileId`를 복사하세요. 이 값은 브라우저별 데이터를 구분하기 위한 것이며 웹사이트 계정이 아닙니다.

이 빌드의 확장 프로그램 ID는 `lpmplddblefacpachnchfgcdebjebdbh`입니다. 확장 프로그램 관리 페이지에 실제로 표시되는 ID와도 비교해야 합니다. 빌드 key를 직접 변경했다면 자신의 ID를 사용해야 합니다.

이제 일반 웹 페이지에서 텍스트를 선택하고 컨텍스트 메뉴 또는 `Alt+Shift+S`로 저장할 수 있습니다. MCP가 아직 연결되지 않았어도 확장 프로그램은 레코드를 저장하고 표시할 수 있어야 합니다.

소스를 업데이트하거나 확장 프로그램 빌드를 교체한 뒤에는 확장 프로그램 관리 페이지에서 해당 확장 프로그램의 ‘새로고침’을 클릭하고 사이드 패널을 다시 여세요. 브라우저 창만 다시 여는 것으로는 새 코드가 로드되었다고 확인할 수 없습니다. 업데이트를 위해 확장 프로그램 데이터를 삭제하지 마세요.

## 3. 로컬 브리지 설치 및 클라이언트 설정 생성

아래의 `YOUR_PROFILE_ID`를 앞 단계의 연결 식별자로 바꾸세요. 설치 프로그램은 Native Messaging 등록 파일, 시작 스크립트 및 MCP 설정 예시를 생성합니다. 기존 파일은 기본적으로 보호됩니다. `INSTALL_TARGET_EXISTS`가 발생하면 기존 파일이 현재 설치의 일부인지 먼저 확인하고, 자신의 이전 설치를 업데이트할 때만 `--overwrite`를 사용하세요.

macOS / Google Chrome:

```sh
node dist/node/cli.js --mode=install \
  --extension-id lpmplddblefacpachnchfgcdebjebdbh \
  --profile-id YOUR_PROFILE_ID \
  --manifest-dir "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  --mcp-config-out ./babel-clipper-mcp.json
```

Chromium을 사용하면 `--manifest-dir`을 `$HOME/Library/Application Support/Chromium/NativeMessagingHosts`로 바꾸세요. Edge에서는 `$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts`를 사용합니다. 각 브라우저는 자체 등록 디렉터리를 읽습니다.

Linux에서 일반적인 경로는 `$HOME/.config/google-chrome/NativeMessagingHosts`, `$HOME/.config/chromium/NativeMessagingHosts` 또는 `$HOME/.config/microsoft-edge/NativeMessagingHosts`입니다. 배포 방식에 따라 다른 디렉터리를 사용할 수 있습니다. Linux는 호환성 매트릭스에 따른 실제 기기 검증이 아직 필요합니다.

Windows에서는 같은 CLI로 파일을 생성한 뒤, 해당 브라우저의 사용자별 Native Messaging 호스트 레지스트리 키 기본값을 생성된 JSON 파일의 절대 경로로 설정합니다. CLI 출력의 `manualBrowserLocations`에 해당 레지스트리 키가 표시됩니다. Windows의 호스트 시작 및 등록은 아직 이 프로젝트에서 실제 기기로 검증하지 않았습니다. 파일 생성만으로 지원이 입증되지는 않습니다.

설치에 성공하면 터미널에 `nativeHost.manifestPath`, `nativeHost.launcherPath`, `mcpConfig.path`를 포함하는 JSON이 반환됩니다. 구성 요소 설치 디렉터리를 이동하거나 삭제하지 마세요. 생성된 설정은 절대 경로를 사용합니다.

`babel-clipper-mcp.json`의 `mcpServers` 아래 항목을 클라이언트의 MCP 설정에 병합하세요. 설정 파일 위치와 외부 형식은 클라이언트마다 다르므로 해당 클라이언트가 제공하는 MCP 설정 진입점을 사용하세요. 생성된 `command`는 로컬 Node의 절대 경로이고 인수에는 구성 요소, 설정 디렉터리 및 `profileId`가 포함됩니다. 저자의 컴퓨터 경로를 입력할 필요가 없습니다.

출력 디렉터리는 다음 중 한 가지 방식으로 설정하면 됩니다.

- 라이브러리의 ‘연결 및 설정’에서 ‘전역 기본 결과물 디렉터리(선택 사항)’를 설정합니다.
- 설치할 때 `--output-root /absolute/path/to/output`을 추가해 MCP 기본 디렉터리를 저장합니다. 또는 특정 클라이언트의 MCP 시작 인수에 `--output-root`를 추가해 해당 연결의 기본값만 재정의할 수 있습니다.
- 한 번의 처리 작업에 대해 사용자 또는 Agent가 절대 디렉터리를 명시합니다.

결정 순서는 작업 지정 디렉터리, MCP 기본값, 확장 프로그램 전역 기본값입니다. 일회성 재정의는 기본값을 변경하지 않습니다. 명시적으로 제공한 디렉터리를 사용할 수 없으면 다른 위치에 몰래 저장하지 않고 오류를 반환합니다.

예를 들어 특정 클라이언트에서 별도의 연결 기본 디렉터리를 사용할 수 있습니다.

```sh
node dist/node/cli.js --mode=mcp --profile-id YOUR_PROFILE_ID --output-root /absolute/path/to/client-output
```

이 명령은 stdio 서비스 시작 명령이며 보통 MCP 클라이언트가 실행합니다. 확장 프로그램의 전역 설정이나 다른 클라이언트의 설정은 변경하지 않습니다.

## 4. 전체 연결 확인

설치 후 라이브러리의 ‘연결 및 설정’에서 ‘로컬 서비스 다시 연결’을 선택하고 클라이언트의 MCP 연결을 시작하거나 새로 고칩니다. 그런 다음 다음 명령을 실행하세요.

```sh
node dist/node/cli.js --mode=doctor --profile-id YOUR_PROFILE_ID
```

설치할 때 `--config-dir`을 사용했다면 진단할 때도 같은 인수를 사용하세요. 결과에 `ready: true`가 포함되고 확장 프로그램 진단도 성공해야 선택한 profile의 전체 연결이 준비된 것입니다. 브라우저 연결 누락, 설정 오류, 호스트 미시작은 각각 다른 상태로 반환됩니다.

Agent에게 “Babel Clipper의 미처리 레코드를 조회해 줘”라고 요청하세요. 조회만으로는 Job을 가져오거나 처리하지 않습니다. 방금 저장한 선택 텍스트를 Agent가 읽을 수 있는지 확인한 뒤 “이 선택 텍스트를 텍스트 파일로 저장하고 처리 결과를 다시 기록해 줘”라고 명시적으로 요청하세요. Agent는 [실행 계약](agent-workflow.md)에 따라 Job을 가져오고 결과물을 저장한 뒤 결과를 커밋합니다. 라이브러리에 ‘처리됨’ 상태와 이번 실행 기록이 표시되어야 합니다.

## 문제 해결

| 증상 | 확인할 내용 |
|---|---|
| `PROFILE_REQUIRED` 또는 profile 불일치 | 현재 브라우저의 라이브러리에서 `profileId`를 복사하고 클라이언트 인수를 확인하세요. 다른 테스트 profile을 사용하면 안 됩니다. |
| Native Host를 찾을 수 없음 | 등록 디렉터리가 현재 브라우저용인지, JSON의 확장 프로그램 ID, 시작 스크립트 경로와 실행 권한을 확인한 다음 다시 연결하세요. |
| `BROKER_UNAVAILABLE` | 확장 프로그램의 로컬 연결 또는 MCP 클라이언트를 시작하세요. doctor는 상태만 확인하며 백그라운드에서 브리지를 시작하지 않습니다. |
| `BROWSER_UNAVAILABLE` | 해당 브라우저와 확장 프로그램을 실행한 상태로 유지하고 라이브러리에서 로컬 서비스 연결 상태를 확인하세요. 이 오류가 대기 목록이 비었다는 뜻은 아닙니다. |
| `WRITEBACK_UNACKNOWLEDGED` 또는 다시 기록하는 중 연결 끊김 | 원래 `requestId`와 완전히 같은 결과 내용을 유지하고, 다시 연결한 뒤 멱등적으로 재전송하세요. 영구 저장 ACK를 받기 전에는 완료했다고 보고하지 마세요. |
| 처리 중 상태에서 Agent 연결이 끊김 | 원래 실행이 아직 진행 중인지 먼저 확인하세요. 시간 초과만으로 시스템이 자동 해제하거나 중복 실행하지 않습니다. |
| 웹 페이지를 수집할 수 없음 | 브라우저 내부 페이지, 권한이 제한된 페이지 또는 특수 리더는 접근할 수 없을 수 있습니다. 명시적으로 표시된 대체 방법을 사용하세요. 스크린샷은 원문이 되지 않습니다. |
| `TAB_CAPTURE_PERMISSION_REQUIRED` | 녹화하려는 웹 페이지로 돌아가 브라우저 도구 모음의 Babel 확장 프로그램 아이콘을 클릭한 뒤 이번 클립의 실시간 저장을 활성화하세요. 해당 페이지에서 텍스트를 먼저 선택하고 실제 단축키로 수집한 뒤 사이드 패널에서 바로 녹화를 시작할 수도 있습니다. 이 경로는 현재 인수 검증을 통과했습니다. 권한 요청은 대상 웹 페이지에서 이루어져야 합니다. 라이브러리 페이지에서 요청한 권한은 비디오 페이지 권한이 아닙니다. 확장 프로그램을 다시 로드한 뒤에는 다시 요청해야 합니다. 민감 정보를 제거한 구체적인 원인은 실패 상세 정보에 저장됩니다. 녹화가 시작되지 않았다면 저장된 것은 시간 범위 레코드뿐입니다. |
| 출력 디렉터리 오류 | 실제로 우선순위가 가장 높은 디렉터리와 현재 운영체제 사용자 권한을 확인하세요. 같은 디렉터리를 두 곳에 중복 설정할 필요는 없습니다. |

확장 프로그램을 제거하거나 브라우저 데이터를 삭제하면 로컬 자료에 영향을 줍니다. 새 profile로 옮기기 전에 백업을 내보내고 첨부 파일 바이트가 포함되었는지 확인하세요. 메타데이터 전용 백업으로는 이미지나 녹화 파일을 복원할 수 없습니다. 외부 Agent가 만든 결과물은 확장 프로그램 첨부 파일 백업에 포함되지 않습니다.
