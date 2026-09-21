import 'fake-indexeddb/auto';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createClipperService } from '../../packages/core/src/index.js';
import type { CaptureDetailResult, CaptureRecord, ClaimBatchResult, CompleteJobResult, CoreService, JobRecord, MutationResult } from '../../packages/core/src/types.js';

const run = promisify(execFile);
const mediaToolsAvailable = !spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error && !spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).error;
let service: CoreService | undefined;
let directory: string | undefined;
afterEach(async () => {
  await service?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe.skipIf(!mediaToolsAvailable)('real media processing and persisted results', () => {
  it('cuts a padded range once with audio, then preserves history after reprocessing', async () => {
    directory = await mkdtemp(join(tmpdir(), 'babel-clipper-media-'));
    service = createClipperService({ databaseName: `media-${crypto.randomUUID()}`, defaultProfileId: 'media-test' });
    const now = new Date().toISOString();
    const created = await service.handle('capture.create', {
      requestId: 'capture-media',
      input: {
        kind: 'media_range', state: 'sealed', captureMethod: 'fixture_media', assetsState: 'location_only',
        source: { title: 'Test signal', pageUrl: 'http://localhost/media.html', site: 'localhost', mediaDurationSeconds: 30.008 },
        selection: { type: 'media', target: 'media_object', timeBasis: 'source_media', startClick: { mediaSeconds: 10, wallTime: now }, endClick: { mediaSeconds: 12, wallTime: now }, segments: [{ start: 10, end: 11 }, { start: 10.5, end: 12 }], events: [], continuity: 'discontinuous' },
        padding: { beforeSeconds: 2, afterSeconds: 2 }, integrity: { status: 'complete_selection', missing: [] },
      },
    }) as MutationResult<{ capture: CaptureRecord }>;
    expect(created.ack.persisted).toBe(true);
    const capture = created.value.capture;
    expect(capture.plannedAcquisitionRanges).toEqual([{ start: 8, end: 14 }]);
    const claimed = await service.handle('job.claim', {
      requestId: 'claim-media', agentId: 'integration-runner', jobIds: [capture.initialJobId],
      taskOutputDirectory: directory, requireOutputDirectory: true,
      execution: { outputs: { videoWithAudio: true }, outputRangePolicy: 'padded' },
    }) as ClaimBatchResult;
    const accepted = claimed.items[0];
    expect(accepted?.disposition).toBe('accepted');
    const output = join(directory, 'clip.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '8', '-i', resolve('tests/fixtures/media/sample.webm'), '-t', '6', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-movflags', '+faststart', output]);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name', '-of', 'json', output]);
    const probe = JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string }[]; format: { duration: string; size: string } };
    expect(probe.streams.map(stream => stream.codec_type).sort()).toEqual(['audio', 'video']);
    expect(Math.abs(Number(probe.format.duration) - 6)).toBeLessThanOrEqual(0.15);
    const bytes = (await stat(output)).size;
    expect(bytes).toBeGreaterThan(0);
    const before = await readFile(output);
    const completion = {
      requestId: 'complete-media', jobId: accepted!.jobId, claimToken: accepted!.claimToken, outcome: 'completed',
      acquisitionMethod: 'source_media', requestedRanges: [{ start: 8, end: 14 }], acquiredRanges: [{ start: 0, end: 30.008 }], outputRanges: [{ start: 8, end: 14 }], paddingInFinalOutput: true,
      artifacts: [{ assetId: 'clip-output', kind: 'video', mimeType: 'video/mp4', fileReference: output, byteLength: bytes, durationSeconds: Number(probe.format.duration), hasVideo: true, hasAudio: true }],
      verification: { level: 'agent_reported', fileExists: true, requiredTracksPresent: true, timeCoverageChecked: true, warnings: [], metadata: { tool: 'ffprobe', toleranceSeconds: 0.15, reencoded: true } },
    };
    const complete = await service.handle('job.complete', completion) as CompleteJobResult;
    expect(complete.ack.persisted).toBe(true);
    const replay = await service.handle('job.complete', completion) as CompleteJobResult;
    expect(replay.result.resultId).toBe(complete.result.resultId);
    const reprocessed = await service.handle('job.reprocess', {
      requestId: 'reprocess-media',
      captureId: capture.captureId,
      execution: { outputRangePolicy: 'original' },
    }) as MutationResult<JobRecord>;
    expect(reprocessed.value.executionOptions).toMatchObject({
      outputRangePolicy: 'original',
      requestedAcquisitionRanges: [{ start: 8, end: 14 }],
      requestedOutputRanges: [{ start: 10, end: 12 }],
    });
    const originalClaim = await service.handle('job.claim', {
      requestId: 'claim-original-media', agentId: 'integration-runner', jobIds: [reprocessed.value.jobId],
      taskOutputDirectory: directory, requireOutputDirectory: true,
    }) as ClaimBatchResult;
    const originalAccepted = originalClaim.items[0];
    expect(originalAccepted?.disposition).toBe('accepted');
    expect(originalAccepted?.job?.executionOptions.requestedOutputRanges).toEqual([{ start: 10, end: 12 }]);
    const originalOutput = join(directory, 'clip-original.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '10', '-i', resolve('tests/fixtures/media/sample.webm'), '-t', '2', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-movflags', '+faststart', originalOutput]);
    const { stdout: originalStdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name', '-of', 'json', originalOutput]);
    const originalProbe = JSON.parse(originalStdout) as { streams: { codec_type: string; codec_name: string }[]; format: { duration: string; size: string } };
    expect(originalProbe.streams.map(stream => stream.codec_type).sort()).toEqual(['audio', 'video']);
    expect(Math.abs(Number(originalProbe.format.duration) - 2)).toBeLessThanOrEqual(0.15);
    const originalBytes = (await stat(originalOutput)).size;
    expect(originalBytes).toBeGreaterThan(0);
    await service.handle('job.complete', {
      requestId: 'complete-original-media', jobId: originalAccepted!.jobId, claimToken: originalAccepted!.claimToken, outcome: 'completed',
      acquisitionMethod: 'source_media', requestedRanges: [{ start: 8, end: 14 }], acquiredRanges: [{ start: 0, end: 30.008 }], outputRanges: [{ start: 10, end: 12 }], paddingInFinalOutput: false,
      artifacts: [{ assetId: 'clip-original-output', kind: 'video', mimeType: 'video/mp4', fileReference: originalOutput, byteLength: originalBytes, durationSeconds: Number(originalProbe.format.duration), hasVideo: true, hasAudio: true }],
      verification: { level: 'agent_reported', fileExists: true, requiredTracksPresent: true, timeCoverageChecked: true, warnings: [], metadata: { tool: 'ffprobe', toleranceSeconds: 0.15, reencoded: true } },
    });
    const detail = await service.handle('capture.get', { captureId: capture.captureId }) as CaptureDetailResult;
    expect(detail.jobs).toHaveLength(2);
    expect(detail.results).toHaveLength(2);
    expect(detail.results[0]?.outputRanges).toEqual([{ start: 8, end: 14 }]);
    expect(detail.results[1]?.outputRanges).toEqual([{ start: 10, end: 12 }]);
    expect(await readFile(output)).toEqual(before);
    await mkdir('artifacts/validation', { recursive: true });
    await writeFile('artifacts/validation/media-processing.json', JSON.stringify({ fixture: 'tests/fixtures/media/sample.webm', paddedOutput: { requestedRange: [8, 14], duration: Number(probe.format.duration), bytes }, originalOutput: { requestedRange: [10, 12], acquisitionRange: [8, 14], duration: Number(originalProbe.format.duration), bytes: originalBytes }, streams: probe.streams, idempotentWriteback: true, oldResultPreserved: true, verificationScope: 'real ffmpeg/ffprobe plus core IndexedDB using fake-indexeddb; browser/Native Host not covered by this test' }, null, 2) + '\n');
  });
});
